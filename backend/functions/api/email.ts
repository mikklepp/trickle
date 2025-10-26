import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Resource } from "sst";
import { randomUUID } from "crypto";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const sqs = new SQSClient({});
const s3 = new S3Client({});

export async function send(event: any) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { sender, recipients, subject, content, attachments = [] } = body;

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

    if (recipientList.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No valid recipients" }),
      };
    }

    const jobId = randomUUID();
    const userId = "default-user"; // TODO: Get from auth context

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
          totalRecipients: recipientList.length,
          sent: 0,
          failed: 0,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      })
    );

    // Create recipient records
    const recipientItems = recipientList.map((email: string) => ({
      PutRequest: {
        Item: {
          jobId,
          email,
          status: "pending",
        },
      },
    }));

    // Batch write recipients (max 25 per batch)
    for (let i = 0; i < recipientItems.length; i += 25) {
      const batch = recipientItems.slice(i, i + 25);
      await dynamo.send(
        new BatchWriteCommand({
          RequestItems: {
            [Resource.RecipientsTable.name]: batch,
          },
        })
      );
    }

    // Send messages to SQS (max 10 per batch)
    for (let i = 0; i < recipientList.length; i += 10) {
      const batch = recipientList.slice(i, i + 10);
      const entries = batch.map((email: string, index: number) => ({
        Id: `${i + index}`,
        MessageBody: JSON.stringify({
          jobId,
          email,
          sender,
          subject,
          content,
          attachments: attachmentKeys,
        }),
        DelaySeconds: Math.floor(i / 10) * 60, // 1 minute delay per batch
      }));

      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: Resource.EmailQueue.url,
          Entries: entries,
        })
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ jobId, totalRecipients: recipientList.length }),
    };
  } catch (error) {
    console.error("Error creating email job:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to create email job" }),
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

    // Get failed recipients
    const recipientsResult = await dynamo.send(
      new QueryCommand({
        TableName: Resource.RecipientsTable.name,
        KeyConditionExpression: "jobId = :jobId",
        FilterExpression: "#status = :failed",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":jobId": jobId,
          ":failed": "failed",
        },
      })
    );

    const failedRecipients =
      recipientsResult.Items?.map((item) => ({
        email: item.email,
        error: item.error,
      })) || [];

    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId: jobResult.Item.jobId,
        status: jobResult.Item.status,
        totalRecipients: jobResult.Item.totalRecipients,
        sent: jobResult.Item.sent,
        failed: jobResult.Item.failed,
        createdAt: jobResult.Item.createdAt,
        failedRecipients,
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
