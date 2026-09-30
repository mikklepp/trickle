/**
 * Sends one job's email to one recipient through SES, and sorts SES failures
 * into the kinds the workflow treats differently:
 *
 *   RetryableSendError  throttled: SES definitely did not take the mail, so
 *                       the claim is released and the step retried later.
 *   AmbiguousSendError  5xx, timeout or lost connection: SES may have taken
 *                       it. Retrying could send it twice, so the recipient is
 *                       reported unconfirmed instead. For the same reason the
 *                       SES client makes exactly one attempt -- the SDK's
 *                       automatic retries would resend on exactly these errors.
 *   FatalSendError      account- or sender-level (sending paused, quota spent,
 *                       identity unverified): every recipient would fail the
 *                       same way, so the job stops instead of burning through
 *                       its list marking everyone failed.
 *   anything else       a 4xx about this message or recipient: recorded as
 *                       failed, and the job moves on.
 */
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { htmlToPlainText } from "../shared/html-to-text.ts";
import { AmbiguousSendError, FatalSendError, RetryableSendError, type Job } from "./model.ts";

export interface Mailer {
  /** Resolves with the SES MessageId once SES has accepted the message. */
  send(job: Job, idx: number, email: string): Promise<string>;
}

const THROTTLED_NAMES = ["TooManyRequestsException", "Throttling", "ThrottlingException"];

const FATAL_NAMES = [
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "LimitExceededException", // daily sending quota spent
  "NotFoundException", // configuration set missing
  "AccessDeniedException",
];

export function classifySesError(error: any): Error {
  const name: string = error?.name ?? "";
  const status: number | undefined = error?.$metadata?.httpStatusCode;
  const message = `${name}: ${error?.message ?? String(error)}`;

  if (THROTTLED_NAMES.includes(name) || status === 429) return new RetryableSendError(message);
  if (FATAL_NAMES.includes(name) || status === 403) return new FatalSendError(message);
  // No HTTP status means no response at all (timeout, connection reset), so
  // there is no telling whether SES processed the request.
  if (status === undefined || status >= 500) return new AmbiguousSendError(message);
  return error instanceof Error ? error : new Error(message);
}

export function sesMailer(options: {
  configurationSetName: string;
  attachmentsBucket: string;
  ses?: SESv2Client;
  s3?: S3Client;
}): Mailer {
  const ses = options.ses ?? new SESv2Client({ maxAttempts: 1 });
  const s3 = options.s3 ?? new S3Client({});

  // A warm container sends a whole job's recipients in a row; fetch each
  // attachment once rather than once per recipient.
  const attachmentCache = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async function attachment(key: string) {
    const cached = attachmentCache.get(key);
    if (cached) return cached;
    // Nothing has reached SES yet, so a failure here is always safe to retry,
    // except an attachment that is gone for good.
    let result;
    let bytes;
    try {
      result = await s3.send(new GetObjectCommand({ Bucket: options.attachmentsBucket, Key: key }));
      bytes = await result.Body?.transformToByteArray();
    } catch (error: any) {
      if (error?.name === "NoSuchKey") throw new FatalSendError(`Attachment ${key} is missing`);
      throw new RetryableSendError(`Reading attachment ${key}: ${error?.message ?? error}`);
    }
    // A missing attachment is not something to silently send without.
    if (!bytes) throw new FatalSendError(`Attachment ${key} could not be read`);
    const loaded = { bytes, contentType: result.ContentType || "application/octet-stream" };
    if (attachmentCache.size > 50) attachmentCache.clear();
    attachmentCache.set(key, loaded);
    return loaded;
  }

  return {
    async send(job, idx, email) {
      const attachments = [];
      for (const key of job.attachments ?? []) {
        const { bytes, contentType } = await attachment(key);
        attachments.push({
          FileName: key.split("/").pop() || "attachment",
          ContentType: contentType,
          RawContent: bytes,
          ContentTransferEncoding: "BASE64" as const,
        });
      }

      const senderAddress = job.sender.match(/<([^>]+)>/)?.[1] || job.sender;
      const headers = [
        { Name: "X-Job-ID", Value: job.jobId },
        { Name: "List-Unsubscribe", Value: `<mailto:${senderAddress}>` },
        ...Object.entries(job.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
      ];

      const input: SendEmailCommandInput = {
        FromEmailAddress: job.sender,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: job.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: htmlToPlainText(job.content) || " ", Charset: "UTF-8" },
              Html: { Data: job.content, Charset: "UTF-8" },
            },
            Headers: headers,
            ...(attachments.length > 0 ? { Attachments: attachments } : {}),
          },
        },
        // Carried into every SES event, so events map back to their exact
        // recipient row without parsing headers.
        EmailTags: [
          { Name: "jobId", Value: job.jobId },
          { Name: "recipientIdx", Value: String(idx) },
        ],
        ConfigurationSetName: options.configurationSetName,
      };

      let result;
      try {
        result = await ses.send(new SendEmailCommand(input));
      } catch (error) {
        throw classifySesError(error);
      }
      // A 200 means SES accepted it, MessageId or not.
      return result.MessageId ?? "(none returned)";
    },
  };
}
