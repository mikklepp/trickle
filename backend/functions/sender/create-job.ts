/**
 * Creates a send job in a bounded number of calls, whatever the list size.
 *
 * Everything a job needs is written first -- attachments, then every
 * recipient row -- and the job row is written last, together with the
 * idempotency marker, as the single commit point. A request that dies before
 * the commit leaves only unreferenced S3 objects and recipient rows, which
 * expire (S3 lifecycle, DynamoDB TTL); nothing sends, because only a
 * committed job ever reaches the queue.
 *
 * A retried request carrying the same Idempotency-Key resolves to the job the
 * first one created, instead of mailing the list a second time.
 */
import type { SendStore } from "./store.ts";
import { advanceQueue, type Executions } from "./queue.ts";
import type { Job } from "./model.ts";

export interface NewJob {
  userId: string;
  sender: string;
  subject: string;
  content: string;
  headers: Record<string, string>;
  recipients: string[];
  attachments: Array<{ filename: string; content: string; contentType: string }>;
  rateLimit: number;
  idempotencyKey?: string;
}

export interface CreateJobDeps {
  store: SendStore;
  executions: Executions;
  /** Stores one attachment under the job and returns its key. */
  uploadAttachment(jobId: string, attachment: NewJob["attachments"][number]): Promise<string>;
  newJobId(): string;
  log?: (message: string) => void;
}

export async function createJob(
  deps: CreateJobDeps,
  input: NewJob
): Promise<{ jobId: string; replayed: boolean }> {
  const { store, log = console.log } = deps;

  if (input.idempotencyKey) {
    const existing = await store.getIdempotentJobId(input.idempotencyKey);
    if (existing) return { jobId: existing, replayed: true };
  }

  const jobId = deps.newJobId();
  const attachmentKeys: string[] = [];
  for (const attachment of input.attachments) {
    attachmentKeys.push(await deps.uploadAttachment(jobId, attachment));
  }
  await store.putRecipients(jobId, input.recipients);

  const job: Job = {
    jobId,
    userId: input.userId,
    status: "queued",
    sender: input.sender,
    subject: input.subject,
    content: input.content,
    headers: input.headers,
    attachments: attachmentKeys,
    totalRecipients: input.recipients.length,
    sent: 0,
    failed: 0,
    unconfirmed: 0,
    // Step Functions waits whole seconds.
    rateLimit: Math.max(1, Math.ceil(input.rateLimit)),
    createdAt: new Date().toISOString(),
  };

  const { replayOf } = await store.commitJob(job, input.idempotencyKey);
  if (replayOf) {
    // A concurrent request with the same key committed first.
    return { jobId: replayOf, replayed: true };
  }

  // Best effort: the reconciler starts the job within a minute regardless.
  try {
    await advanceQueue({ store, executions: deps.executions, log });
  } catch (error) {
    log(
      `Job ${jobId} committed; starting it deferred to the reconciler: ${(error as Error).message}`
    );
  }
  return { jobId, replayed: false };
}
