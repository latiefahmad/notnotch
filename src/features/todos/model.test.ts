import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROJECT, migrate, nextTask, sortTasks, type Task } from "./model.ts";

test("old flat list moves into the default project, order kept", () => {
  const legacy = [
    { id: "a", text: "Newest", done: false, starred: false },
    { id: "b", text: "Older", done: true, starred: true },
    { id: "c", text: "  ", done: false, starred: false },
    "junk",
  ];
  const s = migrate(null, legacy, 1000);
  assert.deepEqual(s.projects, [DEFAULT_PROJECT]);
  assert.equal(s.active, DEFAULT_PROJECT.id);
  assert.deepEqual(s.tasks.map((t) => [t.id, t.projectId, t.done, t.color, t.due, t.alertAt]), [
    ["a", "personal", false, null, null, null],
    ["b", "personal", true, null, null, null],
  ]);
  assert.ok(s.tasks[0].createdAt > s.tasks[1].createdAt);
  assert.deepEqual(migrate(undefined, undefined, 0).tasks, []);
});

test("saved state is repaired", () => {
  const s = migrate(
    { projects: [{ id: "w", name: "Work" }, { bad: 1 }], active: "gone", tasks: [{ id: "x", projectId: "nope", text: "T", color: "pink", due: 50, done: false }] },
    [{ text: "ignored" }],
    0,
  );
  assert.deepEqual(s.projects, [{ id: "w", name: "Work" }]);
  assert.equal(s.active, "w");
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].projectId, "w");
  assert.equal(s.tasks[0].color, null);
  assert.equal(s.tasks[0].alertAt, 50); // no saved alertAt → rings at its due time
  assert.equal(migrate({ projects: [], tasks: [] }, null, 0).projects[0].id, DEFAULT_PROJECT.id);
  // A saved null alertAt (already handled) stays null.
  assert.equal(migrate({ projects: [DEFAULT_PROJECT], tasks: [{ text: "T", due: 50, alertAt: null }] }, null, 0).tasks[0].alertAt, null);
});

const tk = (id: string, p: Partial<Task> = {}): Task => ({ id, projectId: "p", text: id, done: false, starred: false, color: null, due: null, alertAt: null, createdAt: 0, doneAt: null, ...p });

test("order: starred, due soonest, newest; done last", () => {
  const list = [
    tk("plain-old", { createdAt: 1 }),
    tk("done-early", { done: true, doneAt: 1 }),
    tk("due-late", { due: 900 }),
    tk("plain-new", { createdAt: 5 }),
    tk("starred", { starred: true }),
    tk("due-soon", { due: 100 }),
    tk("done-late", { done: true, doneAt: 9 }),
  ];
  assert.deepEqual(sortTasks(list).map((t) => t.id), ["starred", "due-soon", "due-late", "plain-new", "plain-old", "done-late", "done-early"]);
  assert.equal(nextTask(list, "p")?.id, "starred");
  assert.equal(nextTask(list, "other"), null);
  assert.equal(nextTask([tk("d", { done: true })], "p"), null);
});
