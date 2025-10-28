import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { Resource } from "sst";

// AWS SDK automatically detects the region from Lambda execution context
const ses = new SESv2Client({});
const s3 = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const scheduler = new SchedulerClient({});

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

interface EmailMessage {
  jobId: string;
  email: string;
  sender: string;
  subject: string;
  content: string;
  attachments?: string[];
  scheduleName: string;
  headers?: Record<string, string>;
}

export async function handler(event: EmailMessage) {
  console.log("Worker processing email:", event.email, "for job:", event.jobId);

  try {
    // Send email with retry logic
    await sendEmailWithRetry(event);

    // Delete the schedule (cleanup)
    try {
      await scheduler.send(
        new DeleteScheduleCommand({
          Name: event.scheduleName,
        })
      );
      console.log("Deleted schedule:", event.scheduleName);
    } catch (err) {
      console.warn("Failed to delete schedule:", err);
      // Non-critical, continue
    }

    // Increment sent count on job
    const updateResult = await dynamo.send(
      new UpdateCommand({
        TableName: Resource.JobsTable.name,
        Key: { jobId: event.jobId },
        UpdateExpression: "SET sent = sent + :inc",
        ExpressionAttributeValues: {
          ":inc": 1,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    // Check if job is complete
    if (updateResult.Attributes) {
      const { sent, failed, totalRecipients } = updateResult.Attributes;
      if (sent + failed >= totalRecipients) {
        await dynamo.send(
          new UpdateCommand({
            TableName: Resource.JobsTable.name,
            Key: { jobId: event.jobId },
            UpdateExpression: "SET #status = :status, completedAt = :completedAt",
            ExpressionAttributeNames: {
              "#status": "status",
            },
            ExpressionAttributeValues: {
              ":status": failed > 0 ? "completed_with_errors" : "completed",
              ":completedAt": new Date().toISOString(),
            },
          })
        );
        console.log(`Job ${event.jobId} completed: ${sent} sent, ${failed} failed`);
      }
    }

    console.log(`Email sent successfully to: ${event.email}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error("Error processing message:", error);

    // Delete the schedule even on failure
    try {
      await scheduler.send(
        new DeleteScheduleCommand({
          Name: event.scheduleName,
        })
      );
    } catch (err) {
      console.warn("Failed to delete schedule after error:", err);
    }

    // Increment failed count and record error details
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = (error as any).name || "Unknown";

    const updateResult = await dynamo.send(
      new UpdateCommand({
        TableName: Resource.JobsTable.name,
        Key: { jobId: event.jobId },
        UpdateExpression: "SET failed = failed + :inc, lastError = :error, lastErrorAt = :errorAt",
        ExpressionAttributeValues: {
          ":inc": 1,
          ":error": {
            email: event.email,
            errorName,
            errorMessage: errorMessage.substring(0, 500), // Truncate long errors
          },
          ":errorAt": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      })
    );

    // Check if job is complete
    if (updateResult.Attributes) {
      const { sent, failed, totalRecipients } = updateResult.Attributes;
      if (sent + failed >= totalRecipients) {
        await dynamo.send(
          new UpdateCommand({
            TableName: Resource.JobsTable.name,
            Key: { jobId: event.jobId },
            UpdateExpression: "SET #status = :status, completedAt = :completedAt",
            ExpressionAttributeNames: {
              "#status": "status",
            },
            ExpressionAttributeValues: {
              ":status": "completed_with_errors",
              ":completedAt": new Date().toISOString(),
            },
          })
        );
        console.log(`Job ${event.jobId} completed with errors: ${sent} sent, ${failed} failed`);
      }
    }

    throw error; // Re-throw for EventBridge retry
  }
}

function isRetryableError(error: any): boolean {
  // Retry on transient errors
  const retryableErrors = [
    "Throttling",
    "TooManyRequestsException",
    "ServiceUnavailable",
    "InternalServiceError",
    "RequestTimeout",
  ];

  const errorName = error.name || "";
  const errorCode = error.$metadata?.httpStatusCode;

  return (
    retryableErrors.some((e) => errorName.includes(e)) ||
    errorCode === 429 ||
    errorCode === 503 ||
    errorCode === 504
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmailWithRetry(message: EmailMessage): Promise<void> {
  let lastError: any;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await sendEmail(message);
      return; // Success
    } catch (error: any) {
      lastError = error;
      console.error(`Send attempt ${attempt + 1} failed:`, error);

      // Check if error is retryable
      if (!isRetryableError(error)) {
        console.error("Non-retryable error, giving up:", error.name);
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === MAX_RETRIES - 1) {
        console.error("Max retries reached, giving up");
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`Retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

async function sendEmail(message: EmailMessage) {
  // Prepare attachments array if present
  const attachments = [];
  if (message.attachments && message.attachments.length > 0) {
    for (const attachmentKey of message.attachments) {
      const filename = attachmentKey.split("/").pop();

      // Fetch attachment from S3
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: Resource.AttachmentsBucket.name,
          Key: attachmentKey,
        })
      );

      const attachmentData = await result.Body?.transformToByteArray();
      if (!attachmentData) {
        console.warn(`Failed to fetch attachment: ${attachmentKey}`);
        continue;
      }

      // Get content type from S3 metadata, fallback to application/octet-stream
      const contentType = result.ContentType || "application/octet-stream";

      attachments.push({
        FileName: filename || "attachment",
        ContentType: contentType,
        RawContent: new Uint8Array(attachmentData),
        ContentTransferEncoding: "BASE64",
      });
    }
  }

  // Send via SES v2 Simple content type
  const emailParams: any = {
    FromEmailAddress: message.sender,
    Destination: {
      ToAddresses: [message.email],
    },
    Content: {
      Simple: {
        Subject: {
          Data: message.subject,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: message.content,
            Charset: "UTF-8",
          },
        },
        Headers: [],
      },
    },
  };

  // Add custom headers
  if (message.headers) {
    emailParams.Content.Simple.Headers = Object.entries(message.headers).map(([name, value]) => ({
      Name: name,
      Value: value,
    }));
  }

  // Add attachments if present
  if (attachments.length > 0) {
    emailParams.Content.Simple.Attachments = attachments;
  }

  const result = await ses.send(new SendEmailCommand(emailParams));

  console.log("SES Response:", JSON.stringify(result));
  console.log("Message ID:", result.MessageId);
}
