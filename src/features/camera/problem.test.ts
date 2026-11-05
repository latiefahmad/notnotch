import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraProblem } from "./problem.ts";

const err = (name: string) => Object.assign(new Error(name), { name });

test("sorts getUserMedia failures", () => {
  assert.equal(cameraProblem(err("NotFoundError")), "none");
  assert.equal(cameraProblem(err("OverconstrainedError")), "none");
  assert.equal(cameraProblem(err("NotAllowedError")), "denied");
  assert.equal(cameraProblem(err("SecurityError")), "denied");
  assert.equal(cameraProblem(err("NotReadableError")), "busy");
  assert.equal(cameraProblem(err("TrackStartError")), "busy");
  // A DOMException-like object without Error in its chain.
  assert.equal(cameraProblem({ name: "NotAllowedError" }), "denied");
  assert.equal(cameraProblem(err("TypeError")), "other");
  assert.equal(cameraProblem("boom"), "other");
  assert.equal(cameraProblem(null), "other");
});
