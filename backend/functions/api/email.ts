import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from "@aws-sdk/client-scheduler";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, ListEmailIdentitiesCommand } from "@aws-sdk/client-sesv2";
import { Resource } from "sst";
import { randomUUID } from "crypto";
import { verifyToken } from "./auth";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});

// Constants
const MAX_RECIPIENTS = 1000; // Maximum recipients per job
const MAX_SUBJECT_LENGTH = 998; // RFC 5322 limit
const MAX_CONTENT_SIZE = 300000; // 300KB limit for DynamoDB

// Email validation regex (RFC 5322 simplified)
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 320; // RFC max length
}

function validateSubject(subject: string): string | null {
  if (!subject || subject.trim().length === 0) {
    return "Subject is required";
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `Subject too long (max ${MAX_SUBJECT_LENGTH} characters)`;
  }
  return null;
}

function validateContent(content: string): string | null {
  if (!content || content.trim().length === 0) {
    return "Content is required";
  }
  const contentSize = Buffer.from(content).length;
  if (contentSize > MAX_CONTENT_SIZE) {
    return `Content too large (max ${MAX_CONTENT_SIZE / 1000}KB)`;
  }
  return null;
}

async function validateSenderIdentity(sender: string): Promise<boolean> {
  try {
    const result = await ses.send(new ListEmailIdentitiesCommand({}));
    const verifiedEmails =
      result.EmailIdentities?.map((id) => id.IdentityName?.toLowerCase()) || [];
    const senderLower = sender.toLowerCase();

    // Check if sender email or its domain is verified
    const isVerified = verifiedEmails.some((verified) => {
      if (!verified) return false;
      // Exact match or domain match (e.g., verified domain example.com allows any@example.com)
      return (
        verified === senderLower ||
        (verified.startsWith("@") && senderLower.endsWith(verified)) ||
        (senderLower.includes("@") &&
          verified.startsWith("@") &&
          senderLower.split("@")[1] === verified.substring(1))
      );
    });

    return isVerified;
  } catch (error) {
    console.error("Error checking SES verified identities:", error);
    // In case of error checking SES, allow the request to proceed
    // This prevents breaking if there are permission issues
    return true;
  }
}

export async function send(event: any, context: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

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

    // Validate required fields
    if (!sender || !recipients || !subject || !content) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Validate sender email format
    if (!validateEmail(sender)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid sender email format" }),
      };
    }

    // Validate sender against SES verified identities
    const isSenderVerified = await validateSenderIdentity(sender);
    if (!isSenderVerified) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Sender email not verified in SES",
          details: "Please verify this email address or domain in AWS SES before sending",
        }),
      };
    }

    // Validate subject
    const subjectError = validateSubject(subject);
    if (subjectError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: subjectError }),
      };
    }

    // Validate content
    const contentError = validateContent(content);
    if (contentError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: contentError }),
      };
    }

    // Parse recipients (semicolon-separated)
    const recipientList: string[] = recipients
      .split(";")
      .map((email: string) => email.trim())
      .filter((email: string) => email.length > 0);

    // Remove duplicates
    const uniqueRecipients: string[] = Array.from(new Set(recipientList));

    if (uniqueRecipients.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No valid recipients" }),
      };
    }

    // Validate recipient count
    if (uniqueRecipients.length > MAX_RECIPIENTS) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Too many recipients (max ${MAX_RECIPIENTS})`,
          count: uniqueRecipients.length,
        }),
      };
    }

    // Validate each recipient email format
    const invalidRecipients = uniqueRecipients.filter((email) => !validateEmail(email));
    if (invalidRecipients.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid recipient email format",
          invalidEmails: invalidRecipients.slice(0, 10), // Show first 10 invalid emails
        }),
      };
    }

    console.log(`Parsed ${recipientList.length} recipients, ${uniqueRecipients.length} unique`);

    const jobId = randomUUID();
    const userId = auth.userId;

    // Get config for rate limiting
    const configResult = await dynamo.send(
      new GetCommand({
        TableName: Resource.ConfigTable.name,
        Key: { userId },
      })
    );
    const rateLimit = configResult.Item?.rateLimit || 60;
    console.log("Using rate limit:", rateLimit, "seconds");

    // Create job record first (before uploads/schedules)
    const now = new Date();
    const expiresAt = Math.floor(now.getTime() / 1000) + 7 * 24 * 60 * 60; // 7 days in seconds

    await dynamo.send(
      new PutCommand({
        TableName: Resource.JobsTable.name,
        Item: {
          jobId,
          userId,
          sender,
          subject,
          content,
          attachments: [],
          totalRecipients: uniqueRecipients.length,
          sent: 0,
          failed: 0,
          status: "pending",
          createdAt: now.toISOString(),
          expiresAt,
        },
      })
    );

    const attachmentKeys: string[] = [];
    const createdSchedules: string[] = [];

    try {
      // Upload attachments to S3
      for (const attachment of attachments) {
        const key = `${jobId}/${attachment.filename}`;
        const contentType = attachment.contentType || "application/octet-stream";

        await s3.send(
          new PutObjectCommand({
            Bucket: Resource.AttachmentsBucket.name,
            Key: key,
            Body: Buffer.from(attachment.content, "base64"),
            ContentType: contentType,
          })
        );
        attachmentKeys.push(key);
      }

      // Update job with attachment keys
      if (attachmentKeys.length > 0) {
        await dynamo.send(
          new UpdateCommand({
            TableName: Resource.JobsTable.name,
            Key: { jobId },
            UpdateExpression: "SET attachments = :attachments",
            ExpressionAttributeValues: {
              ":attachments": attachmentKeys,
            },
          })
        );
      }

      // Create EventBridge schedules for each recipient
      for (let i = 0; i < uniqueRecipients.length; i++) {
        const email = uniqueRecipients[i];
        const scheduleTime = new Date(now.getTime() + i * rateLimit * 1000);
        const scheduleName = `trickle-${jobId}-${i}`;

        console.log(
          `Scheduling email ${i + 1}/${uniqueRecipients.length} to ${email} at ${scheduleTime.toISOString()}`
        );

        await scheduler.send(
          new CreateScheduleCommand({
            Name: scheduleName,
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
                scheduleName,
              }),
            },
          })
        );

        createdSchedules.push(scheduleName);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ jobId, totalRecipients: uniqueRecipients.length }),
      };
    } catch (error) {
      console.error("Error during job creation, cleaning up:", error);

      // Clean up created schedules
      for (const scheduleName of createdSchedules) {
        try {
          await scheduler.send(new DeleteScheduleCommand({ Name: scheduleName }));
          console.log("Cleaned up schedule:", scheduleName);
        } catch (err) {
          console.error("Failed to clean up schedule:", scheduleName, err);
        }
      }

      // Clean up uploaded attachments
      for (const key of attachmentKeys) {
        try {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: Resource.AttachmentsBucket.name,
              Key: key,
            })
          );
          console.log("Cleaned up attachment:", key);
        } catch (err) {
          console.error("Failed to clean up attachment:", key, err);
        }
      }

      // Mark job as failed
      try {
        await dynamo.send(
          new UpdateCommand({
            TableName: Resource.JobsTable.name,
            Key: { jobId },
            UpdateExpression: "SET #status = :status",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":status": "failed" },
          })
        );
      } catch (err) {
        console.error("Failed to mark job as failed:", err);
      }

      throw error; // Re-throw to return 500
    }
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
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

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
        completedAt: jobResult.Item.completedAt,
        sender: jobResult.Item.sender,
        subject: jobResult.Item.subject,
        lastError: jobResult.Item.lastError,
        lastErrorAt: jobResult.Item.lastErrorAt,
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

export async function list(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const userId = auth.userId;

    // Query jobs by userId using the userIndex GSI
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.JobsTable.name,
        IndexName: "userIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        ScanIndexForward: false, // Sort by createdAt descending (most recent first)
        Limit: 50, // Limit to 50 most recent jobs
      })
    );

    const jobs =
      result.Items?.map((item) => ({
        jobId: item.jobId,
        status: item.status,
        sender: item.sender,
        subject: item.subject,
        totalRecipients: item.totalRecipients,
        sent: item.sent,
        failed: item.failed,
        createdAt: item.createdAt,
      })) || [];

    return {
      statusCode: 200,
      body: JSON.stringify({ jobs }),
    };
  } catch (error) {
    console.error("Error listing jobs:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to list jobs" }),
    };
  }
}
