/**
 * The Step Functions tasks of the SendJob workflow, as plain functions over a
 * SendStore, a Mailer and the queue. handlers.ts wires them to AWS clients.
 *
 *   Begin ─► SendOne ─► (pace? Wait rateLimit) ─► SendOne … ─► Finalize
 *               │ RetryableSendError, retries exhausted ─┐
 *               │ RecordFailedError ─────────────────────┴─► RecordOutcome ─► SendOne …
 *               └ anything else ─► Finalize(failed)
 *
 * See model.ts for the per-recipient state machine these tasks drive.
 */
import {
  AmbiguousSendError,
  FatalSendError,
  RecordFailedError,
  RetryableSendError,
  type JobStatus,
  type Outcome,
  type StepState,
} from "./model.ts";
import type { Mailer } from "./mailer.ts";
import type { SendStore } from "./store.ts";
import { advanceQueue, type Executions } from "./queue.ts";

export interface StepDeps {
  store: SendStore;
  mailer: Mailer;
  executions: Executions;
  log?: (message: string) => void;
  /** Pause between in-process record retries; tests pass 0. */
  retryDelayMs?: number;
}

/** A Step Functions Catch hands the caught error over as { Error, Cause }. */
export interface Caught {
  Error: string;
  Cause: string;
}

const settledState = (jobId: string): StepState => ({
  jobId,
  idx: 0,
  rateLimit: 0,
  done: true,
  pace: false,
});

/**
 * Structured line a CloudWatch metric filter counts; an alarm fires on any.
 * An unconfirmed recipient is the one outcome that needs a human.
 */
function reportUnconfirmed(log: (m: string) => void, jobId: string, idx: number, reason: string) {
  log(JSON.stringify({ event: "UnconfirmedRecipient", jobId, idx, reason }));
}

/** First task: claim the job for this execution. */
export async function begin(
  { store }: Pick<StepDeps, "store">,
  input: { jobId: string; executionArn: string }
): Promise<StepState> {
  const job = await store.getJob(input.jobId);
  if (!job) throw new FatalSendError(`Job ${input.jobId} does not exist`);

  // False when the job was cancelled before its execution got going.
  const active = await store.markSending(input.jobId, input.executionArn);
  if (!active || job.totalRecipients === 0) return settledState(input.jobId);

  return {
    jobId: input.jobId,
    idx: 0,
    rateLimit: job.rateLimit,
    done: false,
    pace: false,
  };
}

async function nextState(store: SendStore, state: StepState, pace: boolean): Promise<StepState> {
  const job = await store.getJob(state.jobId);
  const idx = state.idx + 1;
  return {
    ...state,
    idx,
    pace,
    done: !job || job.status === "cancelled" || idx >= job.totalRecipients,
  };
}

async function recordWithRetry(
  deps: StepDeps,
  state: StepState,
  outcome: Outcome,
  from: "sending" | "pending"
) {
  const delay = deps.retryDelayMs ?? 200;
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.store.record(state.jobId, state.idx, outcome, from);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
}

/** Sends to recipient `state.idx`, at most once. */
export async function sendOne(deps: StepDeps, state: StepState): Promise<StepState> {
  const { store, mailer, log = console.log } = deps;

  const job = await store.getJob(state.jobId);
  if (!job) throw new FatalSendError(`Job ${state.jobId} does not exist`);
  if (job.status === "cancelled" || state.idx >= job.totalRecipients) {
    return { ...state, done: true, pace: false };
  }

  const recipient = await store.getRecipient(state.jobId, state.idx);
  const claim = recipient ? await store.claim(state.jobId, state.idx) : "missing";

  if (claim === "missing") {
    throw new FatalSendError(`Recipient ${state.idx} of job ${state.jobId} does not exist`);
  }
  if (claim === "settled") {
    // An earlier attempt of this step already finished it.
    return nextState(store, state, false);
  }
  if (claim === "in-flight") {
    // An earlier attempt claimed it and then died (Lambda timeout, crash)
    // without recording anything. SES may have accepted the mail.
    await store.markUnconfirmed(state.jobId, state.idx);
    reportUnconfirmed(log, state.jobId, state.idx, "previous attempt did not finish");
    return nextState(store, state, false);
  }

  let outcome: Outcome;
  try {
    const messageId = await mailer.send(job, state.idx, recipient!.email);
    outcome = { state: "sent", messageId };
  } catch (error) {
    if (error instanceof RetryableSendError || error instanceof FatalSendError) {
      // SES did not take it: hand the row back before the workflow retries
      // (Retryable) or stops the job (Fatal).
      await store.release(state.jobId, state.idx);
      throw error;
    }
    if (error instanceof AmbiguousSendError) {
      await store.markUnconfirmed(state.jobId, state.idx);
      reportUnconfirmed(log, state.jobId, state.idx, error.message);
      return nextState(store, state, true);
    }
    outcome = { state: "failed", error: (error as Error).message ?? String(error) };
  }

  try {
    await recordWithRetry(deps, state, outcome, "sending");
  } catch {
    // SES has decided; only the write is missing. The workflow catches this
    // and runs RecordOutcome, which retries the write without resending.
    throw new RecordFailedError(JSON.stringify(outcome));
  }
  return nextState(store, state, true);
}

/**
 * Runs after SendOne gave up in a way that still needs its recipient row
 * settled: the record write kept failing (the outcome travels in the error),
 * or SES kept throttling past the workflow's retries (the recipient fails).
 */
export async function recordOutcome(
  deps: StepDeps,
  input: StepState & { caught: Caught }
): Promise<StepState> {
  const { caught, ...state } = input;
  const message: string = JSON.parse(caught.Cause).errorMessage;

  if (caught.Error === RecordFailedError.name) {
    await recordWithRetry(deps, state, JSON.parse(message) as Outcome, "sending");
  } else {
    await recordWithRetry(deps, state, { state: "failed", error: message }, "pending");
  }
  return nextState(deps.store, state, true);
}

/** Last task, on every path: settle the job, then hand the lease on. */
export async function finalize(
  deps: StepDeps,
  input: { jobId: string; caught?: Caught }
): Promise<{ jobId: string; status: JobStatus }> {
  const { store } = deps;
  const job = await store.getJob(input.jobId);

  let status: JobStatus;
  let error: string | undefined;
  if (input.caught) {
    status = "failed";
    try {
      error = JSON.parse(input.caught.Cause).errorMessage;
    } catch {
      error = input.caught.Cause || input.caught.Error;
    }
  } else if (job && job.failed + job.unconfirmed > 0) {
    status = "completed_with_errors";
  } else {
    status = "completed";
  }

  await store.finalize(input.jobId, status, error);
  await store.releaseLease(input.jobId);
  // The reconciler would get there within a minute; this just avoids the wait.
  try {
    await advanceQueue(deps);
  } catch (e) {
    (deps.log ?? console.log)(`Could not start the next job: ${(e as Error).message}`);
  }
  // Report what was stored: a cancel that raced the last step stays cancelled.
  return { jobId: input.jobId, status: (await store.getJob(input.jobId))?.status ?? status };
}
