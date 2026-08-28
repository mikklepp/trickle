import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyBounce, classifyEvent } from "./event-classifier.ts";
import type { EmailEvent } from "./event-classifier.ts";

// A minimal well-formed event; individual tests override just what they exercise.
const event = (over: Partial<EmailEvent>): EmailEvent => ({
  timestamp: 1_700_000_000_000,
  recipient: "someone@example.com",
  messageId: "0100000000000000-00000000-0000-0000-0000-000000000000-000000",
  jobId: "job-1",
  eventType: "Delivery",
  ...over,
});

// Bounce classification decides whether an address is treated as permanently
// undeliverable. Getting "effectively permanent" wrong means either retrying
// into a wall (reputation damage) or discarding a recoverable address.
describe("classifyBounce", () => {
  test("marks a Permanent bounce as a hard, actionable failure", () => {
    const c = classifyBounce("Permanent", "General");
    assert.equal(c.category, "hard");
    assert.equal(c.severity, "critical");
    assert.equal(c.requiresAction, true);
  });

  test("marks an ordinary Transient bounce as soft and not actionable", () => {
    const c = classifyBounce("Transient", "ServiceUnavailable");
    assert.equal(c.category, "soft");
    assert.equal(c.requiresAction, false);
    assert.equal(c.severity, "info");
  });

  // The documented core of this module: SES's own label is not the last word.
  test("treats a 5.x SMTP status as permanent even when SES says Transient", () => {
    const c = classifyBounce("Transient", "General", undefined, "5.1.1");
    assert.equal(c.requiresAction, true);
    assert.equal(c.severity, "warning");
    assert.match(c.interpretation, /Effectively permanent \(SMTP 5\.1\.1\)/);
  });

  test("does not treat a 4.x SMTP status as permanent", () => {
    const c = classifyBounce("Transient", "General", undefined, "4.4.1");
    assert.equal(c.requiresAction, false);
  });

  test("tolerates whitespace around the SMTP status", () => {
    assert.equal(
      classifyBounce("Transient", "General", undefined, "  5.2.2 ").requiresAction,
      true
    );
  });

  for (const subType of [
    "MessageTooLarge",
    "AttachmentRejected",
    "ContentRejected",
    "MailFromDomainNotVerified",
  ]) {
    test(`flags Transient/${subType} as requiring action`, () => {
      assert.equal(classifyBounce("Transient", subType).requiresAction, true);
    });
  }

  test("reports an unrecognised bounce type as unknown rather than guessing", () => {
    const c = classifyBounce("Wat");
    assert.equal(c.category, "unknown");
    assert.equal(c.requiresAction, false);
  });

  describe("diagnostic codes", () => {
    test("appends the diagnostic code to the interpretation", () => {
      const c = classifyBounce("Permanent", "General", "smtp; 550 no such user");
      assert.match(c.interpretation, /\(smtp; 550 no such user\)$/);
    });

    test("truncates an overlong diagnostic code", () => {
      const c = classifyBounce("Permanent", "General", "x".repeat(400));
      assert.ok(c.interpretation.includes("…"), "expected an ellipsis marking truncation");
      assert.ok(c.interpretation.length < 400, "expected the code to be truncated");
    });

    test("ignores a whitespace-only diagnostic code", () => {
      const c = classifyBounce("Permanent", "General", "   ");
      assert.ok(!c.interpretation.includes("("), "expected no empty parenthetical");
    });
  });
});

describe("classifyEvent", () => {
  test("routes a Bounce event through bounce classification", () => {
    const c = classifyEvent(
      event({ eventType: "Bounce", details: { bounceType: "Permanent", bounceSubType: "General" } })
    );
    assert.equal(c.category, "hard");
  });

  test("classifies a Delivery as informational", () => {
    const c = classifyEvent(event({ eventType: "Delivery" }));
    assert.equal(c.requiresAction, false);
  });
});
