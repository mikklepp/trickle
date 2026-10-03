import { describe, test, expect } from "vitest";
import { isActive, isCancellable, statusLabel } from "./jobStatus";

// isActive drives the polling cadence and the progress display; a status it
// misses keeps a finished job polling every 5s forever (as completed_with_errors did).
describe("job status model", () => {
  test.each(["queued", "sending", "pending"])("%s is active", (status) => {
    expect(isActive(status)).toBe(true);
  });

  test.each(["completed", "completed_with_errors", "cancelled", "failed"])(
    "%s is settled",
    (status) => {
      expect(isActive(status)).toBe(false);
    }
  );

  test("only jobs on the current pipeline can be cancelled", () => {
    expect(isCancellable("queued")).toBe(true);
    expect(isCancellable("sending")).toBe(true);
    expect(isCancellable("pending")).toBe(false);
    expect(isCancellable("completed")).toBe(false);
  });

  test("labels every status", () => {
    expect(statusLabel("completed_with_errors")).toMatch(/with errors/);
    expect(statusLabel("something-new")).toBe("something-new");
  });
});
