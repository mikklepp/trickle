import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({});
const tableName = process.env.EMAIL_EVENTS_TABLE || "trickle-email-events";
const TTL_DAYS = 30;
// Wide enough that every epoch-millisecond value sorts lexically in time order.
const EVENT_TIME_DIGITS = 15;

interface SNSMessage {
  Records: Array<{
    Sns: {
      Message: string;
      Timestamp: string;
    };
  }>;
}

export interface SESEvent {
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
    timestamp?: string;
    bounceSubType?: string;
    bounceType?: string;
    bouncedRecipients?: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    timestamp?: string;
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
 * The job an SES event belongs to. EmailTags are set by the sender and arrive
 * structured, so they win; the X-Job-ID header covers mail sent before tags.
 */
export function extractJobId(event: SESEvent): string {
  const tagged = event.mail.tags?.jobId?.[0];
  if (tagged) return tagged;

  const header = event.mail.headers?.find((h) => h.name.toLowerCase() === "x-job-id");
  if (header) return header.value;

  return "unknown";
}

/** When the event happened according to SES, not when we processed it. */
function eventTimeMs(event: SESEvent): number {
  const perType: Record<string, string | undefined> = {
    Bounce: event.bounce?.timestamp,
    Complaint: event.complaint?.timestamp,
    Delivery: event.delivery?.timestamp,
    Send: event.send?.timestamp,
    Open: event.open?.timestamp,
    Click: event.click?.timestamp,
    Reject: event.reject?.timestamp,
    DeliveryDelay: event.deliveryDelay?.timestamp,
  };
  const parsed = Date.parse(perType[event.eventType] ?? event.mail.timestamp);
  return Number.isNaN(parsed) ? Date.parse(event.mail.timestamp) : parsed;
}

export interface EventRow {
  jobId: string;
  eventKey: string;
  timestamp: number;
  recipient: string;
  eventType: string;
  messageId: string;
  source: string;
  ttl: number;
  details: Record<string, any>;
}

/**
 * One row per recipient the event carries, keyed only by what SES sent.
 *
 * The sort key is derived entirely from the event, so SNS redelivering the
 * same notification overwrites the same rows instead of adding duplicates
 * (which would inflate bounce and complaint counts), and two different events
 * can never collide the way processing-time keys did. It leads with the event
 * time so a Query still returns a job's events in chronological order.
 */
export function buildEventRows(event: SESEvent, nowMs: number): EventRow[] {
  const jobId = extractJobId(event);
  const timestamp = eventTimeMs(event);
  const ttl = Math.floor(nowMs / 1000) + TTL_DAYS * 86400;
  const time = String(timestamp).padStart(EVENT_TIME_DIGITS, "0");

  return getPerRecipientEntries(event).map((entry) => ({
    jobId,
    eventKey: `${time}#${event.mail.messageId}#${event.eventType}#${entry.recipient}`,
    timestamp,
    recipient: entry.recipient,
    eventType: event.eventType,
    messageId: event.mail.messageId,
    source: event.mail.source,
    ttl,
    details: entry.details,
  }));
}

/**
 * Lambda handler for SNS events containing SES notifications.
 *
 * Failures propagate. SNS invokes Lambda asynchronously, so a throw gets
 * Lambda's async retries and then lands on the function's on-failure queue,
 * which is alarmed. Swallowing errors here used to drop events silently, and
 * a lost bounce means the address keeps getting mailed. Retries are safe
 * because the writes are idempotent (see buildEventRows).
 */
export async function handler(event: SNSMessage): Promise<void> {
  for (const record of event.Records) {
    const sesEvent = JSON.parse(record.Sns.Message) as SESEvent;
    const rows = buildEventRows(sesEvent, Date.now());

    for (const row of rows) {
      await dynamodb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(row, { removeUndefinedValues: true }),
        })
      );
    }

    console.log(`Wrote ${rows.length} ${sesEvent.eventType} row(s) for job ${rows[0]?.jobId}`);
  }
}
