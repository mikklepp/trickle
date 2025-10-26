import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
} from "@aws-sdk/client-scheduler";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Resource } from "sst";
import { randomUUID } from "crypto";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});

export async function send(event: any, context: any) {
  try {
    console.log("Received email send request:", JSON.stringify(event.body).substring(0, 500));
    const body = JSON.parse(event.body || "{}");
    const { sender, recipients, subject, content, attachments = [] } = body;
    console.log("Parsed body - attachments count:", attachments.length);

    // Extract account ID and region from current Lambda ARN
    // Format: arn:aws:lambda:region:account-id:function:function-name
    const currentArn = context.invokedFunctionArn;
    const arnParts = currentArn.split(":");
    const region = arnParts[3];
    const accountId = arnParts[4];
    console.log("AWS Region:", region, "Account ID:", accountId);

    // Construct worker Lambda ARN
    const workerArn = `arn:aws:lambda:${region}:${accountId}:function:${Resource.EmailWorker.name}`;

    // Get scheduler role ARN from environment variable
    const schedulerRoleArn = process.env.SCHEDULER_ROLE_ARN;
    if (!schedulerRoleArn) {
      throw new Error("SCHEDULER_ROLE_ARN environment variable not set");
    }
    console.log("Worker ARN:", workerArn);
    console.log("Scheduler Role ARN:", schedulerRoleArn);

    // Validate input
    if (!sender || !recipients || !subject || !content) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Parse recipients (semicolon-separated)
    const recipientList = recipients
      .split(";")
      .map((email: string) => email.trim())
      .filter((email: string) => email.length > 0);

    // Remove duplicates
    const uniqueRecipients = Array.from(new Set(recipientList));

    if (uniqueRecipients.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No valid recipients" }),
      };
    }

    console.log(`Parsed ${recipientList.length} recipients, ${uniqueRecipients.length} unique`);

    const jobId = randomUUID();
    const userId = "default-user"; // TODO: Get from auth context

    // Get config for rate limiting
    const configResult = await dynamo.send(
      new GetCommand({
        TableName: Resource.ConfigTable.name,
        Key: { userId },
      })
    );
    const rateLimit = configResult.Item?.rateLimit || 60;
    console.log("Using rate limit:", rateLimit, "seconds");

    // Upload attachments to S3 if provided
    const attachmentKeys: string[] = [];
    for (const attachment of attachments) {
      const key = `${jobId}/${attachment.filename}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: Resource.AttachmentsBucket.name,
          Key: key,
          Body: Buffer.from(attachment.content, "base64"),
          ContentType: "application/pdf",
        })
      );
      attachmentKeys.push(key);
    }

    // Create job record
    await dynamo.send(
      new PutCommand({
        TableName: Resource.JobsTable.name,
        Item: {
          jobId,
          userId,
          sender,
          subject,
          content,
          attachments: attachmentKeys,
          totalRecipients: uniqueRecipients.length,
          sent: 0,
          failed: 0,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      })
    );

    // Create EventBridge schedules for each recipient
    const now = new Date();
    for (let i = 0; i < uniqueRecipients.length; i++) {
      const email = uniqueRecipients[i];
      const scheduleTime = new Date(now.getTime() + i * rateLimit * 1000);

      console.log(
        `Scheduling email ${i + 1}/${uniqueRecipients.length} to ${email} at ${scheduleTime.toISOString()}`
      );

      await scheduler.send(
        new CreateScheduleCommand({
          Name: `trickle-${jobId}-${i}`,
          ScheduleExpression: `at(${scheduleTime.toISOString().slice(0, -5)})`, // Remove milliseconds
          FlexibleTimeWindow: {
            Mode: FlexibleTimeWindowMode.OFF,
          },
          Target: {
            Arn: workerArn,
            RoleArn: schedulerRoleArn,
            Input: JSON.stringify({
              jobId,
              email,
              sender,
              subject,
              content,
              attachments: attachmentKeys,
              scheduleName: `trickle-${jobId}-${i}`,
            }),
          },
        })
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ jobId, totalRecipients: uniqueRecipients.length }),
    };
  } catch (error) {
    console.error("Error creating email job:", error);
    console.error("Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to create email job",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export async function status(event: any) {
  try {
    const jobId = event.pathParameters?.jobId;

    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing jobId" }),
      };
    }

    // Get job details
    const jobResult = await dynamo.send(
      new GetCommand({
        TableName: Resource.JobsTable.name,
        Key: { jobId },
      })
    );

    if (!jobResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId: jobResult.Item.jobId,
        status: jobResult.Item.status,
        totalRecipients: jobResult.Item.totalRecipients,
        sent: jobResult.Item.sent,
        failed: jobResult.Item.failed,
        createdAt: jobResult.Item.createdAt,
      }),
    };
  } catch (error) {
    console.error("Error fetching job status:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch job status" }),
    };
  }
}
