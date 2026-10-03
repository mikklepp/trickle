/**
 * The send pipeline's data model, shared by the API, the Step Functions tasks
 * and their tests.
 *
 * Each job is one Step Functions execution (named after the jobId) that walks
 * the job's recipient rows in order. Every row moves through
 *
 *   pending ──claim──► sending ──record──► sent | failed
 *                         │
 *                         └─(found still "sending" on a later attempt)──► unconfirmed
 *
 * and the job's counters change in the same transaction as the row, so they
 * are exact. The guarantee is at-most-once: SES has no idempotency token, so
 * a row whose previous attempt died between SES accepting it and the record
 * write cannot be resolved, and is reported as "unconfirmed", never resent.
 */

export type JobStatus =
  "queued" | "sending" | "completed" | "completed_with_errors" | "cancelled" | "failed";

/** Jobs that may still send. Anything else is settled. */
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "sending"];

export type RecipientState = "pending" | "sending" | "sent" | "failed" | "unconfirmed";

export interface Job {
  jobId: string;
  userId: string;
  status: JobStatus;
  sender: string;
  subject: string;
  content: string;
  headers: Record<string, string>;
  attachments: string[];
  totalRecipients: number;
  sent: number;
  failed: number;
  unconfirmed: number;
  /** Seconds between sends, fixed when the job is created. */
  rateLimit: number;
  createdAt: string;
}

export interface Recipient {
  jobId: string;
  idx: number;
  email: string;
  state: RecipientState;
  attempts: number;
  messageId?: string;
  error?: string;
}

export type Outcome = { state: "sent"; messageId: string } | { state: "failed"; error: string };

/**
 * The state Step Functions carries between tasks. Every task returns the
 * whole thing, so the workflow needs no Pass states to stitch results in --
 * which keeps the execution history (capped at 25,000 events) small.
 */
export interface StepState {
  jobId: string;
  /** Next recipient to process. */
  idx: number;
  rateLimit: number;
  /** No more recipients, or the job was cancelled: go to Finalize. */
  done: boolean;
  /** SES was called for this recipient, so wait rateLimit before the next. */
  pace: boolean;
}

// Jobs table key prefixes for the two non-job items it holds. Neither has a
// userId, so they never appear in the userIndex listing.
export const LEASE_JOB_ID = "lease#active";
export const idempotencyItemId = (key: string) => `idem#${key}`;

/** Present only on active jobs: the sparse queueIndex lists exactly those. */
export const QUEUE_ATTRIBUTE_VALUE = "active";

export const RECIPIENT_TTL_DAYS = 30;
export const IDEMPOTENCY_TTL_HOURS = 24;

export const MAX_RECIPIENTS = 1000;

/**
 * Execution-history events one recipient costs: the SendOne task (5), the
 * Choice (2) and the Wait (2), rounded up to leave room for task retries.
 * steps.test.ts asserts MAX_RECIPIENTS fits the budget; raising it
 * past the limit needs the workflow to continue-as-new instead.
 */
export const HISTORY_EVENTS_PER_RECIPIENT = 12;
export const HISTORY_EVENT_BUDGET = 20_000;

/** Errors a task throws to steer the workflow. Names are matched in the state machine. */
export class RetryableSendError extends Error {
  override name = "RetryableSendError";
}
/**
 * SES may or may not have accepted the message (5xx, timeout, connection
 * lost). Retrying could send it twice, so the recipient becomes unconfirmed.
 */
export class AmbiguousSendError extends Error {
  override name = "AmbiguousSendError";
}
/** Account- or sender-level SES failure: every recipient would fail the same way. */
export class FatalSendError extends Error {
  override name = "FatalSendError";
}
/** SES has accepted (or definitively rejected) the mail but the record write failed. */
export class RecordFailedError extends Error {
  override name = "RecordFailedError";
}
