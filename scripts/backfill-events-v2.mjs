/**
 * Copies SES events from the legacy events table into the v2 table.
 *
 * The legacy table was keyed by processing time, which let same-millisecond
 * events overwrite each other; v2 keys each row by what SES sent (see
 * buildEventRows in backend/functions/api/ses-events-processor.ts). Deploying
 * v2 points every reader at the new table, so run this right after that deploy
 * or the last 30 days of job history appear empty.
 *
 * Legacy rows never recorded the SES event time, so their processing time
 * stands in for it in the key. Rows written after the deploy go only to v2,
 * so nothing is copied twice, and re-running the script is harmless: the key
 * is deterministic, so a second run rewrites the same rows.
 *
 *   node scripts/backfill-events-v2.mjs --stage production --region eu-west-1          # dry run
 *   node scripts/backfill-events-v2.mjs --stage production --region eu-west-1 --apply  # write
 */
import { parseArgs } from "node:util";
import { DynamoDBClient, ScanCommand, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    region: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (!values.stage || !values.region) {
  console.error("Usage: backfill-events-v2.mjs --stage <stage> --region <region> [--apply]");
  process.exit(1);
}

const source = `trickle-email-events-${values.stage}`;
const target = `trickle-email-events-v2-${values.stage}`;
const dynamodb = new DynamoDBClient({ region: values.region });
const nowSeconds = Math.floor(Date.now() / 1000);

// Must match EVENT_TIME_DIGITS in ses-events-processor.ts.
const EVENT_TIME_DIGITS = 15;

function toV2(item) {
  const time = item.timestamp.N.padStart(EVENT_TIME_DIGITS, "0");
  const key = `${time}#${item.messageId?.S}#${item.eventType?.S}#${item.recipient?.S}`;
  return { ...item, eventKey: { S: key } };
}

async function writeBatch(requests) {
  let pending = { [target]: requests };
  for (let attempt = 0; Object.keys(pending).length > 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 5000)));
    if (attempt > 8) throw new Error("BatchWriteItem kept returning unprocessed items");
    const result = await dynamodb.send(new BatchWriteItemCommand({ RequestItems: pending }));
    pending = result.UnprocessedItems ?? {};
  }
}

let scanned = 0;
let expired = 0;
let copied = 0;
let batch = [];
let startKey;

do {
  const page = await dynamodb.send(
    new ScanCommand({ TableName: source, ExclusiveStartKey: startKey })
  );
  for (const item of page.Items ?? []) {
    scanned++;
    // DynamoDB deletes expired rows lazily; don't resurrect them.
    if (item.ttl && Number(item.ttl.N) <= nowSeconds) {
      expired++;
      continue;
    }
    batch.push({ PutRequest: { Item: toV2(item) } });
    copied++;
    if (batch.length === 25) {
      if (values.apply) await writeBatch(batch);
      batch = [];
    }
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);

if (batch.length > 0 && values.apply) await writeBatch(batch);

console.log(
  `${values.apply ? "Copied" : "Would copy"} ${copied} of ${scanned} rows ` +
    `from ${source} to ${target} (${expired} already expired, skipped).`
);
if (!values.apply) console.log("Dry run. Re-run with --apply to write.");
