import { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent) {
  // TODO: Process SQS messages and send emails via SES
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    console.log("Processing email:", message);
    // Send email via SES
  }
}
