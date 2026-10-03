import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEventRows, extractJobId, type SESEvent } from "./ses-events-processor.ts";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

const mail = (over: Partial<SESEvent["mail"]> = {}): SESEvent["mail"] => ({
  timestamp: "2026-09-26T10:00:00.000Z",
  source: "sender@example.com",
  sourceArn: "arn:aws:ses:eu-north-1:000000000000:identity/example.com",
  sourceIp: "192.0.2.1",
  sendingAccountId: "000000000000",
  messageId: "msg-1",
  destination: ["a@example.com"],
  headers: [{ name: "X-Job-ID", value: "job-from-header" }],
  ...over,
});

const bounce: SESEvent = {
  eventType: "Bounce",
  mail: mail({ destination: ["a@example.com", "b@example.com"] }),
  bounce: {
    timestamp: "2026-09-26T10:00:05.000Z",
    bounceType: "Permanent",
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: "a@example.com" }, { emailAddress: "b@example.com" }],
  },
};

// These rows feed the "remove hard bounces" advice and the bounce-rate
// warnings, so the two ways the old keying lost or inflated them are pinned.
describe("buildEventRows", () => {
  test("is deterministic, so an SNS redelivery overwrites instead of duplicating", () => {
    const first = buildEventRows(bounce, NOW);
    const redelivered = buildEventRows(bounce, NOW + 60_000);
    assert.deepEqual(
      first.map((r) => r.eventKey),
      redelivered.map((r) => r.eventKey)
    );
  });

  test("gives every recipient of a multi-recipient event its own row", () => {
    const rows = buildEventRows(bounce, NOW);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.eventKey)).size, 2);
  });

  test("distinguishes different event types for the same message", () => {
    const delivery: SESEvent = {
      eventType: "Delivery",
      mail: mail(),
      delivery: { timestamp: "2026-09-26T10:00:05.000Z", recipients: ["a@example.com"] },
    };
    const [d] = buildEventRows(delivery, NOW);
    const [b] = buildEventRows(bounce, NOW);
    assert.notEqual(d.eventKey, b.eventKey);
  });

  test("keeps repeated opens apart by their event time", () => {
    const open = (at: string): SESEvent => ({
      eventType: "Open",
      mail: mail(),
      open: { timestamp: at },
    });
    const [first] = buildEventRows(open("2026-09-26T11:00:00.000Z"), NOW);
    const [second] = buildEventRows(open("2026-09-26T11:05:00.000Z"), NOW);
    assert.notEqual(first.eventKey, second.eventKey);
  });

  test("uses the SES event time, and keys sort chronologically", () => {
    const [row] = buildEventRows(bounce, NOW);
    assert.equal(row.timestamp, Date.parse("2026-09-26T10:00:05.000Z"));

    const early = buildEventRows(
      { ...bounce, bounce: { ...bounce.bounce, timestamp: "2026-09-26T09:59:59.999Z" } },
      NOW
    )[0];
    assert.ok(early.eventKey < row.eventKey);
  });

  test("falls back to the mail timestamp when the event carries none", () => {
    const [row] = buildEventRows({ eventType: "Reject", mail: mail(), reject: {} }, NOW);
    assert.equal(row.timestamp, Date.parse("2026-09-26T10:00:00.000Z"));
  });
});

describe("extractJobId", () => {
  test("prefers the EmailTag over the header", () => {
    const event: SESEvent = {
      eventType: "Send",
      mail: mail({ tags: { jobId: ["job-from-tag"] } }),
    };
    assert.equal(extractJobId(event), "job-from-tag");
  });

  test("falls back to the X-Job-ID header, case-insensitively", () => {
    const event: SESEvent = {
      eventType: "Send",
      mail: mail({ headers: [{ name: "x-job-id", value: "job-lower" }] }),
    };
    assert.equal(extractJobId(event), "job-lower");
  });

  test("marks events it cannot attribute", () => {
    assert.equal(extractJobId({ eventType: "Send", mail: mail({ headers: [] }) }), "unknown");
  });
});
