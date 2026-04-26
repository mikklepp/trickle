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

interface PerRecipientEntry {
  recipient: string;
  details: Record<string, any>;
}

/**
 * Build per-recipient entries for an SES event. Bounce, Complaint, and
 * Delivery events can each carry multiple recipients; we emit one row
 * per recipient so none are lost.
 */
function getPerRecipientEntries(event: SESEvent): PerRecipientEntry[] {
  switch (event.eventType) {
    case "Bounce": {
      const recipients = event.bounce?.bouncedRecipients ?? [];
      if (recipients.length === 0) {
        return [{ recipient: "unknown", details: bounceDetailsBase(event) }];
      }
      return recipients.map((r) => ({
        recipient: r.emailAddress || "unknown",
        details: {
          ...bounceDetailsBase(event),
          bounceStatus: r.status,
          diagnosticCode: r.diagnosticCode,
        },
      }));
    }

    case "Complaint": {
      const recipients = event.complaint?.complainedRecipients ?? [];
      if (recipients.length === 0) {
        return [{ recipient: "unknown", details: { complainedRecipientCount: 0 } }];
      }
      return recipients.map((r) => ({
        recipient: r.emailAddress || "unknown",
        details: { complainedRecipientCount: recipients.length },
      }));
    }

    case "Delivery": {
      const recipients = event.delivery?.recipients ?? [];
      const details = {
        processingTimeMillis: event.delivery?.processingTimeMillis,
        smtpResponse: event.delivery?.smtpResponse,
        remoteMtaIp: event.delivery?.remoteMtaIp,
      };
      if (recipients.length === 0) {
        return [{ recipient: "unknown", details }];
      }
      return recipients.map((r) => ({ recipient: r || "unknown", details }));
    }

    case "Open":
      return [
        {
          recipient: event.mail.destination[0] || "unknown",
          details: { userAgent: event.open?.userAgent },
        },
      ];

    case "Click":
      return [
        {
          recipient: event.mail.destination[0] || "unknown",
          details: {
            link: event.click?.link,
            userAgent: event.click?.userAgent,
          },
        },
      ];

    case "Reject":
      return [
        {
          recipient: event.mail.destination[0] || "unknown",
          details: {
            reason: event.reject?.reason,
            reasonCode: event.reject?.reasonCode,
          },
        },
      ];

    case "DeliveryDelay":
      return [
        {
          recipient: event.mail.destination[0] || "unknown",
          details: {
            delayType: event.deliveryDelay?.delayType,
            processingTimeMillis: event.deliveryDelay?.processingTimeMillis,
          },
        },
      ];

    default:
      return [{ recipient: event.mail.destination[0] || "unknown", details: {} }];
  }
}

function bounceDetailsBase(event: SESEvent): Record<string, any> {
  return {
    bounceType: event.bounce?.bounceType,
    bounceSubType: event.bounce?.bounceSubType,
  };
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
 * Write one DynamoDB row per recipient carried in the SES event.
 * Bounce/Complaint/Delivery can each carry multiple recipients in a single
 * SES notification. The table's sort key is `timestamp`, so we offset
 * each row's timestamp by the recipient index to keep keys unique.
 */
async function writeEventToDynamoDB(event: SESEvent): Promise<void> {
  const jobId = extractJobId(event);
  const baseTimestamp = Date.now();
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const entries = getPerRecipientEntries(event);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const item = {
      jobId,
      timestamp: baseTimestamp + i,
      recipient: entry.recipient,
      eventType: event.eventType,
      messageId: event.mail.messageId,
      source: event.mail.source,
      ttl,
      details: entry.details,
    };

    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(item, { removeUndefinedValues: true }),
      })
    );

    console.log(`Wrote ${event.eventType} event for ${entry.recipient} (job: ${jobId})`);
  }
}

/**
 * Process SNS message containing SES event
 */
async function processSESEvent(message: string): Promise<void> {
  try {
    const event = JSON.parse(message) as SESEvent;
    const jobId = extractJobId(event);
    console.log(`Processing ${event.eventType} event (jobId: ${jobId})`);
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
