import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, ListEmailIdentitiesCommand, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { randomUUID } from "crypto";
import { verifyToken } from "./auth.ts";
import { computeJobMetrics } from "./event-metrics.ts";
import { dynamoStore } from "../sender/store.ts";
import { createJob } from "../sender/create-job.ts";
import { advanceQueue } from "../sender/queue.ts";
import { sfnExecutions } from "../sender/lambda.ts";
import { MAX_RECIPIENTS } from "../sender/model.ts";

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const ses = new SESv2Client({});

// Constants (MAX_RECIPIENTS lives with the send pipeline, which it bounds)
const MAX_SUBJECT_LENGTH = 998; // RFC 5322 limit
const MAX_CONTENT_SIZE = 300000; // 300KB limit for DynamoDB
const MAX_ATTACHMENTS = 10;
// The whole request, base64-encoded attachments included, has to fit Lambda's
// 6MB synchronous payload limit. Base64 adds a third, and the body carries up
// to 300KB of content besides, so 4MB of decoded attachments is what actually
// fits. Anything larger used to die at the gateway with an opaque 413.
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 200;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Email validation regex (RFC 5322 simplified)
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// RFC 5322 sender format: "Display Name" <email@example.com>
const RFC5322_SENDER_REGEX = /^"([^"]*)"\s*<([^>]+)>$/;

// CRLF pattern for header injection detection
const CRLF_PATTERN = /[\r\n]/;

// Valid header name pattern (RFC 5322)
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-^_`a-z0-9|~]+$/i;

/**
 * Escapes display name for RFC 5322 format
 * Escapes quotes and backslashes to prevent format breakage
 * Examples:
 *   John "Johnny" Doe => John \"Johnny\" Doe
 *   John\Doe => John\\Doe
 */
function escapeDisplayName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Extracts the email address from an RFC 5322 formatted sender or plain email
 * Examples:
 *   "John Doe" <john@example.com> => john@example.com
 *   john@example.com => john@example.com
 */
function extractEmailFromSender(sender: string): string {
  const match = sender.match(RFC5322_SENDER_REGEX);
  if (match) {
    return match[2].trim();
  }
  return sender.trim();
}

/**
 * Validates header name (RFC 5322 field-name) and value for injection attacks
 * Returns error message if invalid, null if valid
 */
function validateHeader(name: string, value: string): string | null {
  // Check for CRLF in header name (header injection)
  if (CRLF_PATTERN.test(name)) {
    return `Invalid header name: contains line breaks`;
  }

  // Check for CRLF in header value (header injection)
  if (CRLF_PATTERN.test(value)) {
    return `Invalid header value for "${name}": contains line breaks`;
  }

  // Validate header name format (RFC 5322)
  if (!HEADER_NAME_PATTERN.test(name)) {
    return `Invalid header name "${name}": contains invalid characters`;
  }

  // Check header name length
  if (name.length > 78) {
    return `Header name too long (max 78 characters)`;
  }

  // Check header value length (RFC 5322 recommends 998 characters max)
  if (value.length > 998) {
    return `Header value too long (max 998 characters)`;
  }

  return null;
}

function validateEmail(sender: string): boolean {
  const email = extractEmailFromSender(sender);
  return EMAIL_REGEX.test(email) && email.length <= 320; // RFC max length
}

function validateSubject(subject: string): string | null {
  if (!subject || subject.trim().length === 0) {
    return "Subject is required";
  }
  if (CRLF_PATTERN.test(subject)) {
    return "Subject cannot contain line breaks";
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `Subject too long (max ${MAX_SUBJECT_LENGTH} characters)`;
  }
  return null;
}

/**
 * Sanitize an attachment filename for use as an S3 key segment.
 * Strips any path component, control chars, and odd unicode; collapses
 * leading dots so a malicious "../foo" cannot escape the job prefix.
 */
function sanitizeAttachmentFilename(rawName: string): string {
  const basename = rawName.split(/[\\/]/).pop() || "";
  // Strip control chars and the small set of S3-unfriendly chars
  let cleaned = basename.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\r\n]/g, "");
  cleaned = cleaned.replace(/^\.+/, "");
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

interface AttachmentInput {
  filename?: string;
  content?: string;
  contentType?: string;
}

function validateAttachments(
  attachments: unknown
):
  | { error: string }
  | { sanitized: Array<{ filename: string; content: string; contentType: string }> } {
  if (!Array.isArray(attachments)) {
    return { error: "Attachments must be an array" };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { error: `Too many attachments (max ${MAX_ATTACHMENTS})` };
  }

  const sanitized: Array<{ filename: string; content: string; contentType: string }> = [];
  let totalSize = 0;

  for (const att of attachments as AttachmentInput[]) {
    if (!att || typeof att !== "object") {
      return { error: "Invalid attachment entry" };
    }
    const filename = sanitizeAttachmentFilename(String(att.filename || ""));
    if (!filename) {
      return { error: "Attachment filename is required" };
    }
    const contentType = String(att.contentType || "");
    if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
      return { error: `Unsupported attachment type: ${contentType || "(missing)"}` };
    }
    if (typeof att.content !== "string" || att.content.length === 0) {
      return { error: "Attachment content is required (base64)" };
    }
    // base64 decoded length without actually decoding: 3/4 of input minus padding
    const padding = att.content.endsWith("==") ? 2 : att.content.endsWith("=") ? 1 : 0;
    const decodedSize = Math.floor((att.content.length * 3) / 4) - padding;
    if (decodedSize > MAX_ATTACHMENT_SIZE) {
      return { error: `Attachment "${filename}" exceeds max size (${MAX_ATTACHMENT_SIZE} bytes)` };
    }
    totalSize += decodedSize;
    sanitized.push({ filename, content: att.content, contentType });
  }

  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return { error: `Attachments exceed ${MAX_TOTAL_ATTACHMENT_SIZE} bytes in total` };
  }

  return { sanitized };
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
    // Extract email from RFC 5322 format if needed
    const email = extractEmailFromSender(sender);

    const result = await ses.send(new ListEmailIdentitiesCommand({}));
    const verifiedIdentities =
      result.EmailIdentities?.map((id) => id.IdentityName?.toLowerCase()) || [];
    const emailLower = email.toLowerCase();
    const senderDomain = emailLower.split("@")[1];

    // Check if sender email or its domain is verified
    const isVerified = verifiedIdentities.some((verified) => {
      if (!verified) return false;

      // Exact email match
      if (verified === emailLower) return true;

      // Domain match - verified identity is a domain (no @)
      if (!verified.includes("@") && verified === senderDomain) return true;

      return false;
    });

    return isVerified;
  } catch (error) {
    // Fail closed: an unverifiable sender is refused rather than letting a
    // whole job go out that SES then rejects recipient by recipient.
    console.error("Error checking SES verified identities:", error);
    return false;
  }
}

// Built lazily so importing this module needs no environment.
let pipeline: ReturnType<typeof buildPipeline> | undefined;
function buildPipeline() {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} environment variable not set`);
    return value;
  };
  return {
    store: dynamoStore(env("JOBS_TABLE_NAME"), env("RECIPIENTS_TABLE_NAME")),
    executions: sfnExecutions(env("SEND_JOB_STATE_MACHINE_ARN")),
  };
}
const sendPipeline = () => (pipeline ??= buildPipeline());

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export async function send(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
    if (!auth) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const {
      sender,
      recipients,
      subject,
      content,
      attachments: rawAttachments = [],
      headers = {},
    } = body;
    console.log("Received email send request:", {
      senderPresent: !!sender,
      recipientsLength: typeof recipients === "string" ? recipients.length : 0,
      subjectLength: typeof subject === "string" ? subject.length : 0,
      contentLength: typeof content === "string" ? content.length : 0,
      attachmentsCount: Array.isArray(rawAttachments) ? rawAttachments.length : 0,
      headersCount: headers && typeof headers === "object" ? Object.keys(headers).length : 0,
    });

    const attachmentsResult = validateAttachments(rawAttachments);
    if ("error" in attachmentsResult) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: attachmentsResult.error }),
      };
    }
    const attachments = attachmentsResult.sanitized;

    const idempotencyKey: string | undefined = event.headers?.["idempotency-key"];
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid Idempotency-Key header" }),
      };
    }

    // Validate required fields
    if (!sender || !recipients || !subject || !content) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Enforce RFC 5322 format with display name
    if (!sender.match(RFC5322_SENDER_REGEX)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error:
            'Invalid sender format. Must include display name in format: "Display Name" <email@example.com>',
        }),
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

    // Validate custom headers
    for (const [headerName, headerValue] of Object.entries(headers)) {
      const headerError = validateHeader(headerName, String(headerValue));
      if (headerError) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: headerError }),
        };
      }
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

    // Check SES quota (use max 50% of quota)
    const sesAccount = await ses.send(new GetAccountCommand({}));
    const max24HourSend = sesAccount.SendQuota?.Max24HourSend || 0;
    const sentLast24Hours = sesAccount.SendQuota?.SentLast24Hours || 0;
    const usableQuota = Math.floor(max24HourSend * 0.5); // 50% of quota
    // Jobs already queued or sending will spend quota too; SES only reports
    // what has been sent, so count what they still have to go.
    const { store, executions } = sendPipeline();
    let committed = 0;
    for (const active of await store.activeJobs()) {
      const job = await store.getJob(active.jobId);
      if (job) committed += job.totalRecipients - job.sent - job.failed - job.unconfirmed;
    }
    const available = Math.max(0, usableQuota - sentLast24Hours - committed);

    if (uniqueRecipients.length > available) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Insufficient SES quota`,
          details: `Requested: ${uniqueRecipients.length} emails, Available: ${available} (using 50% of ${max24HourSend} daily limit, ${sentLast24Hours} already sent, ${committed} committed to queued jobs)`,
        }),
      };
    }

    const userId = auth.userId;

    // Get config for rate limiting
    const configResult = await dynamo.send(
      new GetCommand({
        TableName: process.env.CONFIG_TABLE_NAME!,
        Key: { userId },
      })
    );
    const rateLimit = configResult.Item?.rateLimit || 60;

    const { jobId, replayed } = await createJob(
      {
        store,
        executions,
        newJobId: randomUUID,
        async uploadAttachment(jobId, attachment) {
          const key = `${jobId}/${attachment.filename}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: process.env.ATTACHMENTS_BUCKET_NAME!,
              Key: key,
              Body: Buffer.from(attachment.content, "base64"),
              ContentType: attachment.contentType,
            })
          );
          return key;
        },
      },
      {
        userId,
        sender,
        subject,
        content,
        headers: headers || {},
        recipients: uniqueRecipients,
        attachments,
        rateLimit,
        idempotencyKey,
      }
    );
    console.log(
      `Job ${jobId} ${replayed ? "replayed" : "queued"}: ${uniqueRecipients.length} recipients, ${rateLimit}s apart`
    );

    // 202: the job is committed and will be sent, but has not been yet.
    return {
      statusCode: 202,
      body: JSON.stringify({ jobId, status: "queued", totalRecipients: uniqueRecipients.length }),
    };
  } catch (error) {
    console.error("Error creating email job:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to create email job",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

/** Stops a queued or sending job. Recipients already sent stay sent. */
export async function cancel(event: any) {
  try {
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
    if (!auth) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
    }

    const { store, executions } = sendPipeline();
    const job = await store.getJob(jobId);
    if (!job || job.userId !== auth.userId) {
      return { statusCode: 404, body: JSON.stringify({ error: "Job not found" }) };
    }
    if (!(await store.cancel(jobId))) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: `Job is already ${job.status}` }),
      };
    }

    // The status change alone stops it: SendOne checks it before every
    // recipient. Stopping the execution and moving the queue just make it
    // immediate; the reconciler covers either failing.
    try {
      await executions.stop(executions.arnFor(jobId), "Cancelled by user");
      await store.releaseLease(jobId);
      await advanceQueue({ store, executions });
    } catch (error) {
      console.error(`Job ${jobId} cancelled; stopping its execution failed:`, error);
    }

    return { statusCode: 200, body: JSON.stringify({ jobId, status: "cancelled" }) };
  } catch (error) {
    console.error("Error cancelling job:", error);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to cancel job" }) };
  }
}

const RECIPIENT_STATES = new Set(["pending", "sending", "sent", "failed", "unconfirmed"]);

/** A job's recipients and what happened to each, optionally filtered by state. */
export async function recipients(event: any) {
  try {
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
    if (!auth) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
    }
    const state = event.queryStringParameters?.state;
    if (state && !RECIPIENT_STATES.has(state)) {
      return { statusCode: 400, body: JSON.stringify({ error: `Unknown state "${state}"` }) };
    }

    const job = await sendPipeline().store.getJob(jobId);
    if (!job || job.userId !== auth.userId) {
      return { statusCode: 404, body: JSON.stringify({ error: "Job not found" }) };
    }

    // A job has at most MAX_RECIPIENTS rows, small enough to return whole.
    const items: Record<string, any>[] = [];
    let startKey: Record<string, any> | undefined;
    do {
      const page = await dynamo.send(
        new QueryCommand({
          TableName: process.env.RECIPIENTS_TABLE_NAME!,
          KeyConditionExpression: "jobId = :jobId",
          ...(state ? { FilterExpression: "#state = :state" } : {}),
          ExpressionAttributeNames: { "#state": "state", "#error": "error" },
          ExpressionAttributeValues: { ":jobId": jobId, ...(state ? { ":state": state } : {}) },
          ProjectionExpression: "idx, email, #state, attempts, messageId, #error, settledAt",
          ExclusiveStartKey: startKey,
        })
      );
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return { statusCode: 200, body: JSON.stringify({ jobId, recipients: items }) };
  } catch (error) {
    console.error("Error listing recipients:", error);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to list recipients" }) };
  }
}

export async function status(event: any) {
  try {
    // Verify authentication
    const token = event.headers?.authorization?.replace("Bearer ", "");
    const auth = await verifyToken(token);
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
        TableName: process.env.JOBS_TABLE_NAME!,
        Key: { jobId },
      })
    );

    if (!jobResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    // Compute email event metrics (bounces, complaints, etc.)
    const metrics = await computeJobMetrics(jobId, jobResult.Item.totalRecipients);

    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId: jobResult.Item.jobId,
        status: jobResult.Item.status,
        totalRecipients: jobResult.Item.totalRecipients,
        sent: jobResult.Item.sent,
        failed: jobResult.Item.failed,
        unconfirmed: jobResult.Item.unconfirmed ?? 0,
        rateLimit: jobResult.Item.rateLimit,
        startedAt: jobResult.Item.startedAt,
        createdAt: jobResult.Item.createdAt,
        completedAt: jobResult.Item.completedAt,
        sender: jobResult.Item.sender,
        subject: jobResult.Item.subject,
        lastError: jobResult.Item.lastError,
        lastErrorAt: jobResult.Item.lastErrorAt,
        metrics,
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
    const auth = await verifyToken(token);
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
        TableName: process.env.JOBS_TABLE_NAME!,
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
        unconfirmed: item.unconfirmed ?? 0,
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
