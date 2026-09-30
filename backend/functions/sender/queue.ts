/**
 * One job sends at a time. The jobs table holds a single lease item naming
 * the job (and its Step Functions execution) that may send; an execution is
 * only ever started for the job holding it, so queued jobs cost nothing while
 * they wait -- no polling executions growing their history.
 *
 * `advanceQueue` is the only place that starts executions. It is idempotent
 * and safe to run concurrently, and is called:
 *   - by the API right after a job is committed (the fast path),
 *   - by Finalize when a job settles (hands the lease to the next job),
 *   - by the cancel API,
 *   - every minute by the reconciler, which is what guarantees progress when
 *     any of the above failed half-way.
 *
 * Safety comes from the lease's conditional write, not from ordering: two
 * concurrent calls can both decide to start the same head job, and both land
 * on the same execution because it is named after the jobId.
 */
import type { SendStore } from "./store.ts";
import { ACTIVE_STATUSES } from "./model.ts";

export type ExecutionStatus =
  "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "PENDING_REDRIVE" | "MISSING";

export interface Executions {
  /** The execution for a job; deterministic because executions are named by jobId. */
  arnFor(jobId: string): string;
  describe(executionArn: string): Promise<ExecutionStatus>;
  /** Idempotent: starting an already-started job's execution is not an error. */
  start(jobId: string): Promise<void>;
  stop(executionArn: string, cause: string): Promise<void>;
}

export interface QueueDeps {
  store: SendStore;
  executions: Executions;
  log?: (message: string) => void;
}

export type AdvanceResult =
  { action: "busy"; jobId: string } | { action: "started"; jobId: string } | { action: "idle" };

export async function advanceQueue({
  store,
  executions,
  log = console.log,
}: QueueDeps): Promise<AdvanceResult> {
  const lease = await store.getLease();
  let staleHolder: string | undefined;

  if (lease) {
    const status = await executions.describe(lease.executionArn);
    if (status === "RUNNING" || status === "PENDING_REDRIVE") {
      return { action: "busy", jobId: lease.jobId };
    }

    const holder = await store.getJob(lease.jobId);
    const holderActive = holder && ACTIVE_STATUSES.includes(holder.status);

    if (holderActive && status === "MISSING") {
      // The lease was taken but the start never happened (or has not yet).
      await executions.start(lease.jobId);
      log(`Started execution for lease holder ${lease.jobId}`);
      return { action: "started", jobId: lease.jobId };
    }

    if (holderActive) {
      // The execution ended without Finalize settling the job -- Finalize
      // itself kept failing. Settle it here so the queue can move.
      await store.finalize(lease.jobId, "failed", `Execution ended (${status}) without finalizing`);
      log(`Settled job ${lease.jobId} whose execution ended ${status}`);
    }
    staleHolder = lease.executionArn;
  }

  const head = (await store.activeJobs()).find((job) => job.status === "queued");
  if (!head) {
    if (lease) await store.releaseLease(lease.jobId);
    return { action: "idle" };
  }

  const acquired = await store.acquireLease(
    { jobId: head.jobId, executionArn: executions.arnFor(head.jobId) },
    staleHolder
  );
  if (!acquired) {
    // Someone else moved the queue in the meantime; they will start it.
    const current = await store.getLease();
    return current ? { action: "busy", jobId: current.jobId } : { action: "idle" };
  }

  await executions.start(head.jobId);
  log(`Started execution for job ${head.jobId}`);
  return { action: "started", jobId: head.jobId };
}
