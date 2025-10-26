import { SQSEvent } from "aws-lambda";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const ses = new SESClient({});
const s3 = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

interface EmailMessage {
  jobId: string;
  email: string;
  sender: string;
  subject: string;
  content: string;
  attachments?: string[];
}

export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    try {
      const message: EmailMessage = JSON.parse(record.body);
      console.log("Processing email for:", message.email);

      await sendEmail(message);

      // Update recipient status to sent
      await dynamo.send(
        new UpdateCommand({
          TableName: Resource.RecipientsTable.name,
          Key: {
            jobId: message.jobId,
            email: message.email,
          },
          UpdateExpression: "SET #status = :status, sentAt = :sentAt",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": "sent",
            ":sentAt": new Date().toISOString(),
          },
        })
      );

      // Increment sent count on job
      await dynamo.send(
        new UpdateCommand({
          TableName: Resource.JobsTable.name,
          Key: { jobId: message.jobId },
          UpdateExpression: "SET sent = sent + :inc",
          ExpressionAttributeValues: {
            ":inc": 1,
          },
        })
      );

      console.log("Email sent successfully to:", message.email);
    } catch (error) {
      console.error("Error processing message:", error);

      const message: EmailMessage = JSON.parse(record.body);

      // Update recipient status to failed
      await dynamo.send(
        new UpdateCommand({
          TableName: Resource.RecipientsTable.name,
          Key: {
            jobId: message.jobId,
            email: message.email,
          },
          UpdateExpression: "SET #status = :status, #error = :error",
          ExpressionAttributeNames: {
            "#status": "status",
            "#error": "error",
          },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": String(error),
          },
        })
      );

      // Increment failed count on job
      await dynamo.send(
        new UpdateCommand({
          TableName: Resource.JobsTable.name,
          Key: { jobId: message.jobId },
          UpdateExpression: "SET failed = failed + :inc",
          ExpressionAttributeValues: {
            ":inc": 1,
          },
        })
      );

      throw error; // Re-throw to move message to DLQ
    }
  }
}

async function sendEmail(message: EmailMessage) {
  // Build email with attachments
  const boundary = `----=_Part_${Date.now()}`;
  let rawEmail = [
    `From: ${message.sender}`,
    `To: ${message.email}`,
    `Subject: ${message.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    message.content,
    ``,
  ].join("\r\n");

  // Add attachments if present
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
      if (!attachmentData) continue;

      const base64Data = Buffer.from(attachmentData).toString("base64");

      rawEmail += [
        `--${boundary}`,
        `Content-Type: application/pdf; name="${filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${filename}"`,
        ``,
        base64Data,
        ``,
      ].join("\r\n");
    }
  }

  rawEmail += `--${boundary}--`;

  // Send via SES
  await ses.send(
    new SendRawEmailCommand({
      RawMessage: {
        Data: new Uint8Array(Buffer.from(rawEmail)),
      },
      Source: message.sender,
      Destinations: [message.email],
    })
  );
}
