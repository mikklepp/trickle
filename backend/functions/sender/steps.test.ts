import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { begin, finalize, recordOutcome, sendOne, type StepDeps } from "./steps.ts";
import { advanceQueue } from "./queue.ts";
import { createJob } from "./create-job.ts";
import { classifySesError } from "./mailer.ts";
import { FakeExecutions, FakeMailer, FakeStore } from "./store.fake.ts";
import {
  AmbiguousSendError,
  FatalSendError,
  HISTORY_EVENT_BUDGET,
  HISTORY_EVENTS_PER_RECIPIENT,
  MAX_RECIPIENTS,
  RetryableSendError,
  type StepState,
} from "./model.ts";

function setup() {
  const store = new FakeStore();
  const mailer = new FakeMailer();
  const executions = new FakeExecutions();
  const logs: string[] = [];
  const deps: StepDeps = { store, mailer, executions, log: (m) => logs.push(m), retryDelayMs: 0 };
  return { store, mailer, executions, logs, deps };
}

/** A Step Functions Catch payload for an error a task threw. */
const caught = (error: Error) => ({
  Error: error.name,
  Cause: JSON.stringify({ errorType: error.name, errorMessage: error.message }),
});

const SEND_RETRIES = 5; // matches the RetryableSendError retrier in the state machine

/**
 * Drives the tasks the way the SendJob state machine routes them: retries
 * and catches included, waits skipped. Returns the final job status.
 */
async function runJob(deps: StepDeps, jobId: string) {
  let state: StepState = await begin(deps, { jobId, executionArn: `exec:${jobId}` });
  try {
    while (!state.done) {
      let attempts = 0;
      for (;;) {
        try {
          state = await sendOne(deps, state);
          break;
        } catch (error) {
          const name = (error as Error).name;
          if (name === "RetryableSendError" && ++attempts <= SEND_RETRIES) continue;
          if (name === "RetryableSendError" || name === "RecordFailedError") {
            state = await recordOutcome(deps, { ...state, caught: caught(error as Error) });
            break;
          }
          throw error;
        }
      }
    }
    return (await finalize(deps, { jobId })).status;
  } catch (error) {
    return (await finalize(deps, { jobId, caught: caught(error as Error) })).status;
  }
}

describe("sending a job", () => {
  test("sends every recipient once and counts exactly", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x", "c@x"]);

    assert.equal(await runJob(deps, "j"), "completed");
    assert.deepEqual(mailer.sent, ["a@x", "b@x", "c@x"]);
    const job = (await store.getJob("j"))!;
    assert.deepEqual([job.sent, job.failed, job.unconfirmed], [3, 0, 0]);
  });

  test("a retried step whose recipient is already settled does not resend", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x"]);
    const state = await begin(deps, { jobId: "j", executionArn: "exec:j" });

    await sendOne(deps, state);
    const replay = await sendOne(deps, state); // same input, as a Step Functions retry would

    assert.deepEqual(mailer.sent, ["a@x"]);
    assert.equal(replay.pace, false);
    assert.equal((await store.getJob("j"))!.sent, 1);
  });

  test("a recipient left mid-send by a dead attempt becomes unconfirmed, never resent", async () => {
    const { store, mailer, logs, deps } = setup();
    store.addJob("j", ["a@x", "b@x"]);
    await store.claim("j", 0); // an attempt claimed it and then the Lambda died

    assert.equal(await runJob(deps, "j"), "completed_with_errors");
    assert.deepEqual(mailer.sent, ["b@x"]);
    assert.deepEqual(store.states("j"), ["unconfirmed", "sent"]);
    assert.equal((await store.getJob("j"))!.unconfirmed, 1);
    assert.ok(logs.some((l) => l.includes('"event":"UnconfirmedRecipient"')));
  });

  test("an ambiguous SES error is reported unconfirmed, not retried", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x"]);
    let calls = 0;
    mailer.behaviour = (email) => {
      if (email === "a@x") {
        calls++;
        return new AmbiguousSendError("InternalFailure: 500");
      }
    };

    await runJob(deps, "j");
    assert.equal(calls, 1);
    assert.deepEqual(store.states("j"), ["unconfirmed", "sent"]);
  });

  test("throttling is retried and then sends once", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x"]);
    let throttles = 2;
    mailer.behaviour = () =>
      throttles-- > 0 ? new RetryableSendError("TooManyRequestsException") : undefined;

    assert.equal(await runJob(deps, "j"), "completed");
    assert.deepEqual(mailer.sent, ["a@x"]);
    assert.equal((await store.getRecipient("j", 0))!.attempts, 3);
  });

  test("throttling past the retries fails that recipient and the job moves on", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x"]);
    mailer.behaviour = (email) =>
      email === "a@x" ? new RetryableSendError("TooManyRequestsException") : undefined;

    assert.equal(await runJob(deps, "j"), "completed_with_errors");
    assert.deepEqual(store.states("j"), ["failed", "sent"]);
    const job = (await store.getJob("j"))!;
    assert.deepEqual([job.sent, job.failed], [1, 1]);
  });

  test("a recipient-level rejection fails only that recipient", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["bad@x", "b@x"]);
    mailer.behaviour = (email) =>
      email === "bad@x"
        ? Object.assign(new Error("Illegal address"), { name: "MessageRejected" })
        : undefined;

    await runJob(deps, "j");
    assert.deepEqual(store.states("j"), ["failed", "sent"]);
    assert.match((await store.getRecipient("j", 0))!.error!, /Illegal address/);
  });

  test("an account-level failure stops the job and leaves the rest pending", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x", "c@x"]);
    mailer.behaviour = (email) =>
      email === "b@x" ? new FatalSendError("SendingPausedException") : undefined;

    assert.equal(await runJob(deps, "j"), "failed");
    assert.deepEqual(store.states("j"), ["sent", "pending", "pending"]);
    assert.deepEqual(mailer.sent, ["a@x"]);
  });

  test("a failed record write is completed without resending", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x"]);
    store.failNextRecords = 3; // exhausts sendOne's in-process retries

    assert.equal(await runJob(deps, "j"), "completed");
    assert.deepEqual(mailer.sent, ["a@x", "b@x"]);
    assert.equal((await store.getJob("j"))!.sent, 2);
    assert.equal((await store.getRecipient("j", 0))!.messageId, "msg-1");
  });

  test("an attempt that finishes after a retry marked it unconfirmed resolves the row", async () => {
    const { store, deps } = setup();
    store.addJob("j", ["a@x"]);
    await store.claim("j", 0);
    await store.markUnconfirmed("j", 0); // the overlapping retry got there first

    await store.record("j", 0, { state: "sent", messageId: "m" }, "sending");
    const job = (await store.getJob("j"))!;
    assert.deepEqual([job.sent, job.unconfirmed], [1, 0]);
    assert.equal((await store.getRecipient("j", 0))!.state, "sent");
  });

  test("cancelling stops at the next recipient and keeps the status", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x", "b@x", "c@x"]);
    let state = await begin(deps, { jobId: "j", executionArn: "exec:j" });
    state = await sendOne(deps, state);
    await store.cancel("j");
    state = await sendOne(deps, state);

    assert.equal(state.done, true);
    assert.equal((await finalize(deps, { jobId: "j" })).status, "cancelled");
    assert.deepEqual(mailer.sent, ["a@x"]);
  });

  test("a job cancelled before its execution began sends nothing", async () => {
    const { store, mailer, deps } = setup();
    store.addJob("j", ["a@x"]);
    await store.cancel("j");

    const state = await begin(deps, { jobId: "j", executionArn: "exec:j" });
    assert.equal(state.done, true);
    assert.deepEqual(mailer.sent, []);
  });
});

describe("one job at a time", () => {
  test("starts only the oldest queued job while none is running", async () => {
    const { store, executions, deps } = setup();
    store.addJob("first", ["a@x"]);
    store.addJob("second", ["b@x"]);

    assert.deepEqual(await advanceQueue(deps), { action: "started", jobId: "first" });
    assert.deepEqual(await advanceQueue(deps), { action: "busy", jobId: "first" });
    assert.deepEqual(executions.started, ["first"]);
  });

  test("finalizing hands the lease to the next job", async () => {
    const { store, executions, deps } = setup();
    store.addJob("first", ["a@x"]);
    store.addJob("second", ["b@x"]);
    await advanceQueue(deps);

    await runJob(deps, "first");
    executions.status.set(executions.arnFor("first"), "SUCCEEDED");
    assert.deepEqual(executions.started, ["first", "second"]);
    assert.equal(store.lease?.jobId, "second");
  });

  test("recovers a lease whose execution died without finalizing", async () => {
    const { store, executions, deps } = setup();
    store.addJob("first", ["a@x"]);
    store.addJob("second", ["b@x"]);
    await advanceQueue(deps);
    executions.status.set(executions.arnFor("first"), "FAILED");

    assert.deepEqual(await advanceQueue(deps), { action: "started", jobId: "second" });
    assert.equal((await store.getJob("first"))!.status, "failed");
  });

  test("starts a lease holder whose start was lost", async () => {
    const { store, executions, deps } = setup();
    store.addJob("first", ["a@x"]);
    await store.acquireLease({ jobId: "first", executionArn: executions.arnFor("first") });

    assert.deepEqual(await advanceQueue(deps), { action: "started", jobId: "first" });
  });

  test("skips cancelled jobs and releases an idle lease", async () => {
    const { store, deps } = setup();
    store.addJob("first", ["a@x"]);
    await store.cancel("first");
    assert.deepEqual(await advanceQueue(deps), { action: "idle" });
    assert.equal(store.lease, null);
  });
});

describe("creating a job", () => {
  const input = {
    userId: "u",
    sender: '"S" <s@x>',
    subject: "s",
    content: "<p>c</p>",
    headers: {},
    recipients: ["a@x", "b@x"],
    attachments: [],
    rateLimit: 1.5,
  };

  function createDeps() {
    const { store, executions, deps } = setup();
    let ids = 0;
    return {
      store,
      executions,
      create: {
        store,
        executions,
        uploadAttachment: async () => "key",
        newJobId: () => `job-${++ids}`,
        log: deps.log,
      },
    };
  }

  test("commits the job with its recipients and starts it", async () => {
    const { store, executions, create } = createDeps();
    const { jobId } = await createJob(create, input);

    assert.deepEqual(store.states(jobId), ["pending", "pending"]);
    assert.equal((await store.getJob(jobId))!.rateLimit, 2);
    assert.deepEqual(executions.started, [jobId]);
  });

  test("a replayed Idempotency-Key returns the original job", async () => {
    const { store, create } = createDeps();
    const first = await createJob(create, { ...input, idempotencyKey: "k" });
    const again = await createJob(create, { ...input, idempotencyKey: "k" });

    assert.deepEqual(again, { jobId: first.jobId, replayed: true });
    assert.equal(store.jobs.size, 1);
  });
});

describe("classifySesError", () => {
  const sdkError = (name: string, status?: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  test("throttling is retryable", () => {
    assert.ok(
      classifySesError(sdkError("TooManyRequestsException", 429)) instanceof RetryableSendError
    );
  });
  test("5xx and no response at all are ambiguous", () => {
    assert.ok(classifySesError(sdkError("InternalFailure", 500)) instanceof AmbiguousSendError);
    assert.ok(classifySesError(sdkError("TimeoutError")) instanceof AmbiguousSendError);
  });
  test("account-level errors are fatal", () => {
    assert.ok(classifySesError(sdkError("SendingPausedException", 400)) instanceof FatalSendError);
  });
  test("recipient-level 4xx fails the recipient", () => {
    const error = classifySesError(sdkError("MessageRejected", 400));
    assert.ok(!(error instanceof RetryableSendError || error instanceof FatalSendError));
    assert.ok(!(error instanceof AmbiguousSendError));
  });
});

test("the largest allowed job fits the Step Functions history budget", () => {
  assert.ok(MAX_RECIPIENTS * HISTORY_EVENTS_PER_RECIPIENT < HISTORY_EVENT_BUDGET);
});
