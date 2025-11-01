import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({});
const tableName = process.env.EMAIL_EVENTS_TABLE || "trickle-email-events";
const TTL_DAYS = 30;

interface SNSMessage {
  Records: Array<{
    Sns: {
      Message: string;
      Timestamp: string;
    };
  }>;
}

interface SESEvent {
  eventType: string;
  mail: {
    timestamp: string;
    source: string;
    sourceArn: string;
    sourceIp: string;
    sendingAccountId: string;
    messageId: string;
    destination: string[];
    headers?: Array<{
      name: string;
      value: string;
    }>;
    commonHeaders?: {
      from: string[];
      to: string[];
      messageId: string;
      subject?: string;
      date?: string;
    };
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceSubType?: string;
    bounceType?: string;
    bouncedRecipients?: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    complainedRecipients?: Array<{
      emailAddress: string;
    }>;
  };
  delivery?: {
    recipients?: string[];
    timestamp?: string;
    processingTimeMillis?: number;
    smtpResponse?: string;
    remoteMtaIp?: string;
  };
  send?: {
    timestamp?: string;
  };
  open?: {
    timestamp?: string;
    userAgent?: string;
  };
  click?: {
    timestamp?: string;
    userAgent?: string;
    link?: string;
    linkTags?: Record<string, string[]>;
  };
  reject?: {
    timestamp?: string;
    reason?: string;
    reasonCode?: string;
  };
  deliveryDelay?: {
    timestamp?: string;
    processingTimeMillis?: number;
    delayType?: string;
    expirationTimeInMillis?: number;
  };
}

/**
 * Extract recipient email from SES event
 */
function getRecipient(event: SESEvent): string {
  switch (event.eventType) {
    case "Bounce":
      return event.bounce?.bouncedRecipients?.[0]?.emailAddress || "unknown";
    case "Complaint":
      return event.complaint?.complainedRecipients?.[0]?.emailAddress || "unknown";
    case "Delivery":
      return event.delivery?.recipients?.[0] || "unknown";
    default:
      return event.mail.destination[0] || "unknown";
  }
}

/**
 * Parse SES event and extract event-specific details
 */
function getEventDetails(event: SESEvent): Record<string, any> {
  const details: Record<string, any> = {};

  switch (event.eventType) {
    case "Bounce":
      details.bounceType = event.bounce?.bounceType;
      details.bounceSubType = event.bounce?.bounceSubType;
      if (event.bounce?.bouncedRecipients?.[0]) {
        details.bounceStatus = event.bounce.bouncedRecipients[0].status;
        details.diagnosticCode = event.bounce.bouncedRecipients[0].diagnosticCode;
      }
      break;

    case "Complaint":
      details.complainedRecipientCount = event.complaint?.complainedRecipients?.length || 0;
      break;

    case "Delivery":
      details.processingTimeMillis = event.delivery?.processingTimeMillis;
      details.smtpResponse = event.delivery?.smtpResponse;
      details.remoteMtaIp = event.delivery?.remoteMtaIp;
      break;

    case "Open":
      details.userAgent = event.open?.userAgent;
      break;

    case "Click":
      details.link = event.click?.link;
      details.userAgent = event.click?.userAgent;
      break;

    case "Reject":
      details.reason = event.reject?.reason;
      details.reasonCode = event.reject?.reasonCode;
      break;

    case "DeliveryDelay":
      details.delayType = event.deliveryDelay?.delayType;
      details.processingTimeMillis = event.deliveryDelay?.processingTimeMillis;
      break;
  }

  return details;
}

/**
 * Extract jobId from email headers
 */
function extractJobId(event: SESEvent): string {
  // Try to get from X-Job-ID header
  if (event.mail.headers) {
    const jobIdHeader = event.mail.headers.find((h) => h.name.toLowerCase() === "x-job-id");
    if (jobIdHeader) {
      return jobIdHeader.value;
    }
  }

  // Fallback to commonHeaders if available
  if (event.mail.commonHeaders?.["X-Job-ID"]) {
    const headerValue = event.mail.commonHeaders["X-Job-ID"];
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  }

  return "unknown";
}

/**
 * Write SES event to DynamoDB
 */
async function writeEventToDynamoDB(event: SESEvent): Promise<void> {
  const jobId = extractJobId(event);
  const recipient = getRecipient(event);
  const timestamp = Date.now();
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;

  const item = {
    jobId,
    timestamp,
    recipient,
    eventType: event.eventType,
    messageId: event.mail.messageId,
    source: event.mail.source,
    ttl,
    details: getEventDetails(event),
  };

  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item),
    })
  );

  console.log(`Wrote ${event.eventType} event for ${recipient} (job: ${jobId})`);
}

/**
 * Process SNS message containing SES event
 */
async function processSESEvent(message: string): Promise<void> {
  try {
    const event = JSON.parse(message) as SESEvent;
    const jobId = extractJobId(event);
    console.log(`Processing ${event.eventType} event for ${getRecipient(event)} (jobId: ${jobId})`);
    await writeEventToDynamoDB(event);
  } catch (error) {
    console.error("Error processing SES event:", error);
    throw error;
  }
}

/**
 * Lambda handler for SNS events containing SES notifications
 */
export async function handler(event: SNSMessage): Promise<void> {
  console.log("Processing SES events from SNS");

  for (const record of event.Records) {
    try {
      const message = record.Sns.Message;
      await processSESEvent(message);
    } catch (error) {
      console.error("Error processing record:", error);
      // Continue processing other records even if one fails
    }
  }
}
