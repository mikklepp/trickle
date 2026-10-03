/**
 * One-off steps for moving a stage to another region (production:
 * eu-west-1 -> eu-north-1). See "Moving production to eu-north-1" in
 * DEPLOYMENT.md for the order they run in. Every step is a dry run unless
 * --apply is given.
 *
 *   preflight         Is anything still due to send from the old region?
 *                     Lists leftover EventBridge schedules and unfinished jobs.
 *   seed-suppression  SES suppression lists are per region, and the old region
 *                     never had account-level suppression on, so known-bad
 *                     addresses exist only as events. Adds every hard bounce
 *                     and complaint from the old events tables to the new
 *                     region's account suppression list.
 *   copy-config       Copies the config table (rate limit, default headers)
 *                     into the new stack's table. Run after the new deploy.
 *
 *   node scripts/migrate-region.mjs <step> --stage production --from eu-west-1 --to eu-north-1 [--apply]
 */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { DynamoDBClient, ScanCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { SESv2Client, PutSuppressedDestinationCommand } from "@aws-sdk/client-sesv2";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const [step] = positionals;
const { stage, from, to, apply } = values;
if (!step || !stage || !from || !to) {
  console.error(
    "Usage: migrate-region.mjs <preflight|seed-suppression|copy-config> --stage <stage> --from <region> --to <region> [--apply]"
  );
  process.exit(1);
}

const source = new DynamoDBClient({ region: from });
const target = new DynamoDBClient({ region: to });

async function scanAll(client, params) {
  const items = [];
  let startKey;
  do {
    const page = await client.send(new ScanCommand({ ...params, ExclusiveStartKey: startKey }));
    items.push(...(page.Items ?? []).map((item) => unmarshall(item)));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function tableExists(client, name) {
  try {
    await client.send(new ScanCommand({ TableName: name, Limit: 1 }));
    return true;
  } catch (error) {
    if (error.name === "ResourceNotFoundException") return false;
    throw error;
  }
}

async function preflight() {
  // The old pipeline gives every recipient its own one-time schedule; any
  // left over is a mail that will still go out from the old region.
  const schedules = JSON.parse(
    execFileSync(
      "aws",
      [
        "scheduler",
        "list-schedules",
        "--region",
        from,
        "--name-prefix",
        "trickle-",
        "--output",
        "json",
      ],
      { encoding: "utf8" }
    )
  ).Schedules;

  const jobs = await scanAll(source, {
    TableName: `trickle-jobs-${stage}`,
    ProjectionExpression: "jobId, #s, sent, failed, totalRecipients, createdAt",
    ExpressionAttributeNames: { "#s": "status" },
  });
  const unfinished = jobs.filter(
    (j) => j.status === "pending" && (j.sent ?? 0) + (j.failed ?? 0) < (j.totalRecipients ?? 0)
  );

  console.log(`Schedules still registered in ${from}: ${schedules.length}`);
  for (const s of schedules.slice(0, 20)) console.log(`  ${s.Name}  ${s.State}`);
  console.log(`Unfinished jobs in trickle-jobs-${stage}: ${unfinished.length}`);
  for (const j of unfinished) {
    console.log(
      `  ${j.jobId}  ${j.createdAt}  ${j.sent ?? 0}+${j.failed ?? 0}/${j.totalRecipients}`
    );
  }
  if (schedules.length > 0) {
    console.log(
      "\nNot safe yet: those schedules will invoke the old worker. Wait for them, or delete them " +
        "if they belong to a job that was abandoned (the old pipeline orphaned schedules when " +
        "job creation timed out)."
    );
    process.exit(1);
  }
  if (unfinished.length > 0) {
    console.log(
      "\nNo schedules remain, so these jobs will never finish; they are leftovers, not in flight."
    );
  }
  console.log("\nSafe: nothing is due to send from the old region.");
}

async function seedSuppression() {
  const tables = [`trickle-email-events-${stage}`, `trickle-email-events-v2-${stage}`];
  const suppress = new Map(); // address -> reason; COMPLAINT wins over BOUNCE
  for (const table of tables) {
    if (!(await tableExists(source, table))) {
      console.log(`${table}: not present in ${from}, skipped`);
      continue;
    }
    const events = await scanAll(source, {
      TableName: table,
      FilterExpression: "eventType IN (:bounce, :complaint)",
      ExpressionAttributeValues: { ":bounce": { S: "Bounce" }, ":complaint": { S: "Complaint" } },
    });
    for (const e of events) {
      if (!e.recipient || e.recipient === "unknown") continue;
      const address = e.recipient.toLowerCase();
      if (e.eventType === "Complaint") suppress.set(address, "COMPLAINT");
      else if (e.details?.bounceType === "Permanent" && !suppress.has(address)) {
        suppress.set(address, "BOUNCE");
      }
    }
    console.log(`${table}: ${events.length} bounce/complaint events`);
  }

  // The SES mailbox simulator is not a real address and must stay mailable.
  for (const address of suppress.keys()) {
    if (address.endsWith("@simulator.amazonses.com")) suppress.delete(address);
  }

  const counts = { BOUNCE: 0, COMPLAINT: 0 };
  for (const reason of suppress.values()) counts[reason]++;
  console.log(
    `${apply ? "Adding" : "Would add"} ${suppress.size} addresses to the ${to} suppression list ` +
      `(${counts.BOUNCE} hard bounces, ${counts.COMPLAINT} complaints).`
  );
  if (!apply) return;

  const ses = new SESv2Client({ region: to });
  for (const [EmailAddress, Reason] of suppress) {
    await ses.send(new PutSuppressedDestinationCommand({ EmailAddress, Reason }));
  }
  console.log(
    "Done. Adding an address that is already suppressed is a no-op, so re-running is safe."
  );
}

async function copyConfig() {
  const table = `trickle-config-${stage}`;
  if (!(await tableExists(target, table))) {
    console.error(`${table} does not exist in ${to} yet: deploy the new stack first.`);
    process.exit(1);
  }
  const items = await scanAll(source, { TableName: table });
  for (const item of items) {
    console.log(
      `  ${item.userId}: rateLimit=${item.rateLimit} headers=${JSON.stringify(item.headers ?? {})}`
    );
  }
  console.log(`${apply ? "Copying" : "Would copy"} ${items.length} config item(s) to ${to}.`);
  if (!apply) return;
  for (const item of items) {
    await target.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall(item, { removeUndefinedValues: true }),
      })
    );
  }
  console.log("Done.");
}

const steps = { preflight, "seed-suppression": seedSuppression, "copy-config": copyConfig };
if (!steps[step]) {
  console.error(`Unknown step "${step}". Use: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await steps[step]();
if (!apply && step !== "preflight") console.log("Dry run. Re-run with --apply to write.");
