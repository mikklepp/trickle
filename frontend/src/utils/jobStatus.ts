/**
 * Job statuses as the API reports them, mirroring backend/functions/sender/model.ts.
 * "pending" is how jobs created before the Step Functions pipeline were
 * stored; they still show up in the job list until they expire.
 */
export type JobStatusValue =
  "queued" | "sending" | "completed" | "completed_with_errors" | "cancelled" | "failed" | "pending";

const ACTIVE = new Set<string>(["queued", "sending", "pending"]);

/** Still sending, or waiting to. Everything else is final (though SES events keep arriving). */
export const isActive = (status?: string) => status !== undefined && ACTIVE.has(status);

/** Only jobs on the current pipeline can be cancelled; legacy "pending" jobs cannot. */
export const isCancellable = (status?: string) => status === "queued" || status === "sending";

const LABELS: Record<string, string> = {
  queued: "⏳ Queued",
  sending: "📤 Sending",
  pending: "📤 Sending",
  completed: "✅ Completed",
  completed_with_errors: "⚠️ Completed with errors",
  cancelled: "⏹️ Cancelled",
  failed: "❌ Failed",
};

export const statusLabel = (status: string) => LABELS[status] ?? status;
