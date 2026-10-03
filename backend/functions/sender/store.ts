/**
 * Every DynamoDB access the send pipeline makes, behind one interface.
 *
 * The workflow logic (send-one.ts, steps.ts, create-job.ts) only talks to a
 * SendStore, so its tests run against an in-memory fake with the same
 * semantics (store.fake.ts) instead of mocking SDK calls. The correctness of
 * the pipeline rests on the conditions written here: each state transition is
 * conditional on the state it leaves, and each counter moves in the same
 * transaction as its row.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  LEASE_JOB_ID,
  QUEUE_ATTRIBUTE_VALUE,
  RECIPIENT_TTL_DAYS,
  IDEMPOTENCY_TTL_HOURS,
  idempotencyItemId,
  type Job,
  type JobStatus,
  type Outcome,
  type Recipient,
} from "./model.ts";

export type ClaimResult = "claimed" | "settled" | "in-flight" | "missing";

export interface ActiveJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  executionArn?: string;
}

export interface Lease {
  jobId: string;
  executionArn: string;
}

export interface SendStore {
  getJob(jobId: string): Promise<Job | null>;
  getRecipient(jobId: string, idx: number): Promise<Recipient | null>;

  /** pending → sending. Reports why when the row is not pending. */
  claim(jobId: string, idx: number): Promise<ClaimResult>;
  /** sending → pending, after a transient failure that SES definitely did not accept. */
  release(jobId: string, idx: number): Promise<void>;
  /**
   * `from` → outcome, with the job counter, atomically. Replaying a record
   * that already happened is a no-op, so it is safe to retry.
   */
  record(jobId: string, idx: number, outcome: Outcome, from: "sending" | "pending"): Promise<void>;
  /** sending → unconfirmed, with the job counter, atomically. Idempotent. */
  markUnconfirmed(jobId: string, idx: number): Promise<void>;

  /** Active (queued or sending) jobs, oldest first. */
  activeJobs(): Promise<ActiveJob[]>;
  getLease(): Promise<Lease | null>;
  /** Take the lease if it is free, already ours, or held by `staleHolder`. */
  acquireLease(lease: Lease, staleHolder?: string): Promise<boolean>;
  /** Release the lease if `jobId` holds it. */
  releaseLease(jobId: string): Promise<void>;

  /** queued → sending. False if the job is no longer active (cancelled first). */
  markSending(jobId: string, executionArn: string): Promise<boolean>;
  /** Settle the job and drop it from the active queue. Leaves a cancelled job cancelled. */
  finalize(jobId: string, status: JobStatus, error?: string): Promise<void>;
  /** Cancel a job that is still active. False if it had already settled. */
  cancel(jobId: string): Promise<boolean>;

  putRecipients(jobId: string, emails: string[]): Promise<void>;
  /**
   * The commit point of job creation: the job and its idempotency marker are
   * written together. Returns the jobId an earlier request with the same key
   * already created, if there was one.
   */
  commitJob(job: Job, idempotencyKey?: string): Promise<{ replayOf?: string }>;
  getIdempotentJobId(idempotencyKey: string): Promise<string | null>;
}

const ttlFromNow = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

const isConditionFailure = (error: any) =>
  error?.name === "ConditionalCheckFailedException" ||
  (error?.name === "TransactionCanceledException" &&
    (error.CancellationReasons ?? []).some((r: any) => r?.Code === "ConditionalCheckFailed"));

export function dynamoStore(
  jobsTable: string,
  recipientsTable: string,
  doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
): SendStore {
  const recipientKey = (jobId: string, idx: number) => ({ jobId, idx });

  const store: SendStore = {
    async getJob(jobId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: jobsTable, Key: { jobId }, ConsistentRead: true })
      );
      return (Item as Job) ?? null;
    },

    async getRecipient(jobId, idx) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: recipientsTable,
          Key: recipientKey(jobId, idx),
          ConsistentRead: true,
        })
      );
      return (Item as Recipient) ?? null;
    },

    async claim(jobId, idx) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: recipientsTable,
            Key: recipientKey(jobId, idx),
            UpdateExpression: "SET #state = :sending, claimedAt = :now ADD attempts :one",
            ConditionExpression: "#state = :pending",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":sending": "sending",
              ":pending": "pending",
              ":now": new Date().toISOString(),
              ":one": 1,
            },
          })
        );
        return "claimed";
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        const row = await store.getRecipient(jobId, idx);
        if (!row) return "missing";
        return row.state === "sending" ? "in-flight" : "settled";
      }
    },

    async release(jobId, idx) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: recipientsTable,
            Key: recipientKey(jobId, idx),
            UpdateExpression: "SET #state = :pending REMOVE claimedAt",
            ConditionExpression: "#state = :sending",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":pending": "pending", ":sending": "sending" },
          })
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    },

    async record(jobId, idx, outcome, from) {
      const counter = outcome.state === "sent" ? "sent" : "failed";
      const detail =
        outcome.state === "sent"
          ? { name: "messageId", value: outcome.messageId }
          : { name: "error", value: outcome.error.slice(0, 500) };

      const transition = (leaving: string, counters: string) =>
        doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: recipientsTable,
                  Key: recipientKey(jobId, idx),
                  UpdateExpression: `SET #state = :outcome, ${detail.name} = :detail, settledAt = :now`,
                  ConditionExpression: "#state = :leaving",
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: {
                    ":outcome": outcome.state,
                    ":detail": detail.value,
                    ":now": new Date().toISOString(),
                    ":leaving": leaving,
                  },
                },
              },
              {
                Update: {
                  TableName: jobsTable,
                  Key: { jobId },
                  UpdateExpression: counters,
                  ExpressionAttributeValues: {
                    ":one": 1,
                    ...(leaving === "unconfirmed" ? { ":minusOne": -1 } : {}),
                  },
                },
              },
            ],
          })
        );

      try {
        await transition(from, `ADD ${counter} :one`);
        return;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }

      const row = await store.getRecipient(jobId, idx);
      // Already recorded by an earlier attempt of this same step.
      if (row?.state === outcome.state) return;
      // A retry of the step found this row mid-send and marked it unconfirmed
      // while this attempt was still running. This attempt knows what SES
      // did, so it resolves the row -- and moves the counter with it.
      if (row?.state === "unconfirmed" && from === "sending") {
        await transition("unconfirmed", `ADD ${counter} :one, unconfirmed :minusOne`);
        return;
      }
      throw new Error(
        `Recipient ${idx} of job ${jobId} is ${row?.state ?? "missing"}, expected ${from}`
      );
    },

    async markUnconfirmed(jobId, idx) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: recipientsTable,
                  Key: recipientKey(jobId, idx),
                  UpdateExpression: "SET #state = :unconfirmed, settledAt = :now",
                  ConditionExpression: "#state = :sending",
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: {
                    ":unconfirmed": "unconfirmed",
                    ":sending": "sending",
                    ":now": new Date().toISOString(),
                  },
                },
              },
              {
                Update: {
                  TableName: jobsTable,
                  Key: { jobId },
                  UpdateExpression: "ADD unconfirmed :one",
                  ExpressionAttributeValues: { ":one": 1 },
                },
              },
            ],
          })
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        const row = await store.getRecipient(jobId, idx);
        if (row?.state !== "unconfirmed") throw error;
      }
    },

    async activeJobs() {
      const jobs: ActiveJob[] = [];
      let startKey: Record<string, any> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: jobsTable,
            IndexName: "queueIndex",
            KeyConditionExpression: "#queue = :active",
            ExpressionAttributeNames: { "#queue": "queue", "#status": "status" },
            ExpressionAttributeValues: { ":active": QUEUE_ATTRIBUTE_VALUE },
            ProjectionExpression: "jobId, #status, createdAt, executionArn",
            ScanIndexForward: true,
            ExclusiveStartKey: startKey,
          })
        );
        jobs.push(...((page.Items ?? []) as ActiveJob[]));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return jobs;
    },

    async getLease() {
      const { Item } = await doc.send(
        new GetCommand({ TableName: jobsTable, Key: { jobId: LEASE_JOB_ID }, ConsistentRead: true })
      );
      return Item ? { jobId: Item.holder, executionArn: Item.executionArn } : null;
    },

    async acquireLease(lease, staleHolder) {
      try {
        await doc.send(
          new PutCommand({
            TableName: jobsTable,
            Item: {
              jobId: LEASE_JOB_ID,
              holder: lease.jobId,
              executionArn: lease.executionArn,
              acquiredAt: new Date().toISOString(),
            },
            ConditionExpression: staleHolder
              ? "attribute_not_exists(jobId) OR executionArn = :me OR executionArn = :stale"
              : "attribute_not_exists(jobId) OR executionArn = :me",
            ExpressionAttributeValues: {
              ":me": lease.executionArn,
              ...(staleHolder ? { ":stale": staleHolder } : {}),
            },
          })
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async releaseLease(jobId) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: jobsTable,
            Key: { jobId: LEASE_JOB_ID },
            ConditionExpression: "holder = :jobId",
            ExpressionAttributeValues: { ":jobId": jobId },
          })
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    },

    async markSending(jobId, executionArn) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: jobsTable,
            Key: { jobId },
            UpdateExpression: "SET #status = :sending, startedAt = :now, executionArn = :arn",
            ConditionExpression: "#status IN (:queued, :sending)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":sending": "sending",
              ":queued": "queued",
              ":now": new Date().toISOString(),
              ":arn": executionArn,
            },
          })
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async finalize(jobId, status, error) {
      const now = new Date().toISOString();
      try {
        await doc.send(
          new UpdateCommand({
            TableName: jobsTable,
            Key: { jobId },
            UpdateExpression: `SET #status = :status, completedAt = :now${
              error ? ", lastError = :error, lastErrorAt = :now" : ""
            } REMOVE #queue`,
            ConditionExpression: "attribute_not_exists(cancelledAt)",
            ExpressionAttributeNames: { "#status": "status", "#queue": "queue" },
            ExpressionAttributeValues: {
              ":status": status,
              ":now": now,
              ...(error ? { ":error": { errorMessage: error.slice(0, 500) } } : {}),
            },
          })
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        // Cancelled while the last step ran: it stays cancelled.
        await doc.send(
          new UpdateCommand({
            TableName: jobsTable,
            Key: { jobId },
            UpdateExpression: "SET completedAt = :now REMOVE #queue",
            ExpressionAttributeNames: { "#queue": "queue" },
            ExpressionAttributeValues: { ":now": now },
          })
        );
      }
    },

    async cancel(jobId) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: jobsTable,
            Key: { jobId },
            UpdateExpression: "SET #status = :cancelled, cancelledAt = :now REMOVE #queue",
            ConditionExpression: "#status IN (:queued, :sending)",
            ExpressionAttributeNames: { "#status": "status", "#queue": "queue" },
            ExpressionAttributeValues: {
              ":cancelled": "cancelled",
              ":queued": "queued",
              ":sending": "sending",
              ":now": new Date().toISOString(),
            },
          })
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    async putRecipients(jobId, emails) {
      const ttl = ttlFromNow(RECIPIENT_TTL_DAYS * 86400);
      const requests = emails.map((email, idx) => ({
        PutRequest: {
          Item: { jobId, idx, email, state: "pending", attempts: 0, ttl },
        },
      }));
      const chunks: (typeof requests)[] = [];
      for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25));

      // A few batches in flight at once: 1000 recipients is 40 batches.
      const CONCURRENCY = 4;
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          let pending: Record<string, any> = { [recipientsTable]: chunks[next++] };
          for (let attempt = 0; Object.keys(pending).length > 0; attempt++) {
            if (attempt > 8) throw new Error("BatchWrite kept returning unprocessed items");
            if (attempt > 0)
              await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 2000)));
            const result = await doc.send(new BatchWriteCommand({ RequestItems: pending }));
            pending = result.UnprocessedItems ?? {};
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    },

    async commitJob(job, idempotencyKey) {
      const put = {
        Put: {
          TableName: jobsTable,
          Item: {
            ...job,
            queue: QUEUE_ATTRIBUTE_VALUE,
            expiresAt: ttlFromNow(RECIPIENT_TTL_DAYS * 86400),
          },
          ConditionExpression: "attribute_not_exists(jobId)",
        },
      };
      if (!idempotencyKey) {
        await doc.send(new TransactWriteCommand({ TransactItems: [put] }));
        return {};
      }
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              put,
              {
                Put: {
                  TableName: jobsTable,
                  Item: {
                    jobId: idempotencyItemId(idempotencyKey),
                    targetJobId: job.jobId,
                    expiresAt: ttlFromNow(IDEMPOTENCY_TTL_HOURS * 3600),
                  },
                  ConditionExpression: "attribute_not_exists(jobId)",
                },
              },
            ],
          })
        );
        return {};
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        const replayOf = await store.getIdempotentJobId(idempotencyKey);
        if (!replayOf) throw error;
        return { replayOf };
      }
    },

    async getIdempotentJobId(idempotencyKey) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: jobsTable,
          Key: { jobId: idempotencyItemId(idempotencyKey) },
          ConsistentRead: true,
        })
      );
      return Item?.targetJobId ?? null;
    },
  };
  return store;
}
