import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDLERS } from "./handlers.ts";

// Loads each entrypoint the way Lambda would and checks the wired export exists.
// This is the only thing standing between a renamed handler and a 500 in
// production -- see the note in handlers.ts.
for (const [id, { module: modulePath, export: exportName }] of Object.entries(HANDLERS)) {
  test(`${id} resolves ${modulePath}#${exportName}`, async () => {
    const loaded = await import(`./${modulePath}`);
    assert.equal(
      typeof loaded[exportName],
      "function",
      `${modulePath} does not export a function named "${exportName}"`
    );
  });
}
