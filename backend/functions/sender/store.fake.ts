/**
 * In-memory SendStore, Mailer and Executions for tests.
 *
 * The fake store enforces the same conditions store.ts writes to DynamoDB --
 * each transition only from the state it leaves, counters moving with their
 * rows -- so the workflow tests exercise the real concurrency rules, not a
 * happy-path stub. Keep the two in step when either changes.
 */
import type { ActiveJob, ClaimResult, Lease, SendStore } from "./store.ts";
import type { Job, JobStatus, Outcome, Recipient } from "./model.ts";
import type { Mailer } from "./mailer.ts";
import type { ExecutionStatus, Executions } from "./queue.ts";

export class FakeStore implements SendStore {
  jobs = new Map<string, Job & { queue?: string; cancelledAt?: string; lastError?: string }>();
  recipients = new Map<string, Recipient>();
  lease: Lease | null = null;
  idempotency = new Map<string, string>();
  /** Make the next N record() calls throw, to simulate DynamoDB failing after SES accepted. */
  failNextRecords = 0;

  private key = (jobId: string, idx: number) => `${jobId}#${idx}`;

  async getJob(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async getRecipient(jobId: string, idx: number) {
    const row = this.recipients.get(this.key(jobId, idx));
    return row ? { ...row } : null;
  }

  async claim(jobId: string, idx: number): Promise<ClaimResult> {
    const row = this.recipients.get(this.key(jobId, idx));
    if (!row) return "missing";
    if (row.state === "pending") {
      row.state = "sending";
      row.attempts++;
      return "claimed";
    }
    return row.state === "sending" ? "in-flight" : "settled";
  }

  async release(jobId: string, idx: number) {
    const row = this.recipients.get(this.key(jobId, idx));
    if (row?.state === "sending") row.state = "pending";
  }

  async record(jobId: string, idx: number, outcome: Outcome, from: "sending" | "pending") {
    if (this.failNextRecords > 0) {
      this.failNextRecords--;
      throw new Error("simulated DynamoDB failure");
    }
    const row = this.recipients.get(this.key(jobId, idx))!;
    const job = this.jobs.get(jobId)!;
    const counter = outcome.state === "sent" ? "sent" : "failed";
    const apply = () => {
      row.state = outcome.state;
      if (outcome.state === "sent") row.messageId = outcome.messageId;
      else row.error = outcome.error;
      job[counter]++;
    };

    if (row.state === from) return apply();
    if (row.state === outcome.state) return;
    if (row.state === "unconfirmed" && from === "sending") {
      job.unconfirmed--;
      return apply();
    }
    throw new Error(`Recipient ${idx} of job ${jobId} is ${row.state}, expected ${from}`);
  }

  async markUnconfirmed(jobId: string, idx: number) {
    const row = this.recipients.get(this.key(jobId, idx))!;
    if (row.state === "unconfirmed") return;
    if (row.state !== "sending") throw new Error(`Recipient ${idx} is ${row.state}`);
    row.state = "unconfirmed";
    this.jobs.get(jobId)!.unconfirmed++;
  }

  async activeJobs(): Promise<ActiveJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.queue)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ jobId, status, createdAt }) => ({ jobId, status, createdAt }));
  }

  async getLease() {
    return this.lease ? { ...this.lease } : null;
  }

  async acquireLease(lease: Lease, staleHolder?: string) {
    const current = this.lease;
    if (
      !current ||
      current.executionArn === lease.executionArn ||
      (staleHolder !== undefined && current.executionArn === staleHolder)
    ) {
      this.lease = { ...lease };
      return true;
    }
    return false;
  }

  async releaseLease(jobId: string) {
    if (this.lease?.jobId === jobId) this.lease = null;
  }

  async markSending(jobId: string, _executionArn: string) {
    const job = this.jobs.get(jobId)!;
    if (job.status !== "queued" && job.status !== "sending") return false;
    job.status = "sending";
    return true;
  }

  async finalize(jobId: string, status: JobStatus, error?: string) {
    const job = this.jobs.get(jobId)!;
    delete job.queue;
    if (job.cancelledAt) return;
    job.status = status;
    if (error) job.lastError = error;
  }

  async cancel(jobId: string) {
    const job = this.jobs.get(jobId)!;
    if (job.status !== "queued" && job.status !== "sending") return false;
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    delete job.queue;
    return true;
  }

  async putRecipients(jobId: string, emails: string[]) {
    emails.forEach((email, idx) =>
      this.recipients.set(this.key(jobId, idx), {
        jobId,
        idx,
        email,
        state: "pending",
        attempts: 0,
      })
    );
  }

  async commitJob(job: Job, idempotencyKey?: string) {
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      return { replayOf: this.idempotency.get(idempotencyKey)! };
    }
    this.jobs.set(job.jobId, { ...job, queue: "active" });
    if (idempotencyKey) this.idempotency.set(idempotencyKey, job.jobId);
    return {};
  }

  async getIdempotentJobId(idempotencyKey: string) {
    return this.idempotency.get(idempotencyKey) ?? null;
  }

  /** Test helper: a committed job with `emails` as its recipients. */
  addJob(jobId: string, emails: string[], over: Partial<Job> = {}) {
    this.putRecipients(jobId, emails);
    this.jobs.set(jobId, {
      jobId,
      userId: "u",
      status: "queued",
      sender: '"Sender" <sender@example.com>',
      subject: "Subject",
      content: "<p>Hi</p>",
      headers: {},
      attachments: [],
      totalRecipients: emails.length,
      sent: 0,
      failed: 0,
      unconfirmed: 0,
      rateLimit: 60,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.jobs.size)).toISOString(),
      queue: "active",
      ...over,
    });
  }

  states(jobId: string) {
    return [...this.recipients.values()]
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => a.idx - b.idx)
      .map((r) => r.state);
  }
}

/** Records every send; `behaviour` decides what SES does for each address. */
export class FakeMailer implements Mailer {
  sent: string[] = [];
  behaviour: (email: string) => Error | undefined = () => undefined;

  async send(_job: Job, _idx: number, email: string) {
    const error = this.behaviour(email);
    if (error) throw error;
    this.sent.push(email);
    return `msg-${this.sent.length}`;
  }
}

export class FakeExecutions implements Executions {
  status = new Map<string, ExecutionStatus>();
  started: string[] = [];

  arnFor(jobId: string) {
    return `arn:aws:states:eu-north-1:0:execution:send-job:${jobId}`;
  }
  async describe(executionArn: string) {
    return this.status.get(executionArn) ?? "MISSING";
  }
  async start(jobId: string) {
    const arn = this.arnFor(jobId);
    if (!this.status.has(arn)) {
      this.status.set(arn, "RUNNING");
      this.started.push(jobId);
    }
  }
  async stop(executionArn: string) {
    if (this.status.get(executionArn) === "RUNNING") this.status.set(executionArn, "ABORTED");
  }
}
