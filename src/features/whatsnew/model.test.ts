import { test } from "node:test";
import assert from "node:assert/strict";
import { whatsNew } from "./model.ts";

test("what's new: an offered update first, then unseen changes, nothing on a fresh install", () => {
  const none = { available: null, dismissed: null, unseen: null };
  assert.equal(whatsNew(none), null);
  assert.deepEqual(whatsNew({ ...none, unseen: "0.3.1" }), { kind: "updated", version: "0.3.1" });
  assert.deepEqual(whatsNew({ ...none, available: "0.3.2" }), { kind: "available", version: "0.3.2" });
  assert.deepEqual(whatsNew({ ...none, available: "0.3.2", unseen: "0.3.1" }), { kind: "available", version: "0.3.2" });
  // Waved away: no daily reminder for that version, but the unseen changes still show, and the next version does too.
  assert.equal(whatsNew({ ...none, available: "0.3.2", dismissed: "0.3.2" }), null);
  assert.deepEqual(whatsNew({ available: "0.3.2", dismissed: "0.3.2", unseen: "0.3.1" }), { kind: "updated", version: "0.3.1" });
  assert.deepEqual(whatsNew({ ...none, available: "0.3.3", dismissed: "0.3.2" }), { kind: "available", version: "0.3.3" });
});
