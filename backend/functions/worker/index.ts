import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { Resource } from "sst";

const ses = new SESv2Client({});
const s3 = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const scheduler = new SchedulerClient({});

interface EmailMessage {
  jobId: string;
  email: string;
  sender: string;
  subject: string;
  content: string;
  attachments?: string[];
  scheduleName: string;
}

export async function handler(event: EmailMessage) {
  console.log("Worker processing email:", event.email, "for job:", event.jobId);

  try {
    // Send email
    await sendEmail(event);

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

    // Increment failed count on job
    const updateResult = await dynamo.send(
      new UpdateCommand({
        TableName: Resource.JobsTable.name,
        Key: { jobId: event.jobId },
        UpdateExpression: "SET failed = failed + :inc",
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

      attachments.push({
        FileName: filename || "attachment.pdf",
        ContentType: "application/pdf",
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
      },
    },
  };

  // Add attachments if present
  if (attachments.length > 0) {
    emailParams.Content.Simple.Attachments = attachments;
  }

  const result = await ses.send(new SendEmailCommand(emailParams));

  console.log("SES Response:", JSON.stringify(result));
  console.log("Message ID:", result.MessageId);
}
