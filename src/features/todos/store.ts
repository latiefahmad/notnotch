import { createStore } from "../../lib/store";
import { alarmRinging, playAlarm } from "../../lib/sound";
import { settings } from "../../settings/store";
import { DEFAULT_PROJECT, migrate, type Task, type TodoState } from "./model";
import { MAX_WAIT_MS, dueReminders, nextAlert, snoozeAt, wait } from "./schedule";

const KEY = "notch:todo-projects";
/** The flat list of NotNotch 0.2 and earlier. Read once to migrate, never written or deleted, so an older version still finds it. */
const LEGACY_KEY = "notch:todos";

function readRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const hadState = readRaw(KEY) !== null;
export const todos = createStore<TodoState>({ projects: [DEFAULT_PROJECT], active: DEFAULT_PROJECT.id, tasks: [] }, { persist: "todo-projects" });
todos.set((s) => migrate(hadState ? s : null, hadState ? null : readRaw(LEGACY_KEY), Date.now()));

/** Tasks whose reminder rings now, oldest first. Set by the scheduler, empty while the To-do tool is off. */
export const dueTasks = createStore<Task[]>([]);

const patchTask = (id: string, p: Partial<Task> | ((t: Task) => Partial<Task>)) =>
  todos.set((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)) }));

export const todoActions = {
  add(text: string, due: number | null = null) {
    const now = Date.now();
    todos.set((s) => ({
      ...s,
      tasks: [{ id: crypto.randomUUID(), projectId: s.active, text, done: false, starred: false, color: null, due, alertAt: due, createdAt: now, doneAt: null }, ...s.tasks],
    }));
  },
  patch: (id: string, p: Partial<Pick<Task, "text" | "starred" | "color">>) => patchTask(id, p),
  remove: (id: string) => todos.set((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== id) })),
  /** A new due time also re-arms the reminder; null removes both. */
  setDue: (id: string, due: number | null) => patchTask(id, { due, alertAt: due }),
  toggleDone: (id: string) =>
    patchTask(id, (t) => (t.done ? { done: false, doneAt: null, alertAt: t.due !== null && t.due > Date.now() ? t.due : null } : { done: true, doneAt: Date.now(), alertAt: null })),
  done: (id: string) => patchTask(id, { done: true, doneAt: Date.now(), alertAt: null }),
  snooze: (id: string) => patchTask(id, { alertAt: snoozeAt(Date.now()) }),
  clearDone: (projectId: string) => todos.set((s) => ({ ...s, tasks: s.tasks.filter((t) => !(t.projectId === projectId && t.done)) })),

  addProject(name: string) {
    const id = crypto.randomUUID();
    todos.set((s) => ({ ...s, projects: [...s.projects, { id, name }], active: id }));
  },
  renameProject: (id: string, name: string) => todos.set((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) })),
  /** Deletes the project with its tasks; the last project stays. */
  removeProject: (id: string) =>
    todos.set((s) => {
      if (s.projects.length <= 1) return s;
      const projects = s.projects.filter((p) => p.id !== id);
      return { projects, active: s.active === id ? projects[0].id : s.active, tasks: s.tasks.filter((t) => t.projectId !== id) };
    }),
  setActive: (id: string) => todos.set((s) => ({ ...s, active: id })),
};

// One scheduler for the whole app: a timeout to the next reminder (at most a minute, so standby and clock
// changes are caught), nothing while no reminder is pending or the To-do tool is off.
let timeout: number | undefined;
let lastKey = "";
const rung = new Set<string>();

function check() {
  window.clearTimeout(timeout);
  const now = Date.now();
  const { tasks } = todos.get();
  const s = settings.get();
  const on = s.tools.some((t) => t.id === "todos" && t.enabled);
  const due = on ? dueReminders(tasks, now) : [];

  // One chime per reminder that has just come due (not for ones missed while the app was closed), never over a ringing timer.
  let fresh = false;
  for (const t of due) {
    const k = `${t.id}:${t.alertAt}`;
    if (!rung.has(k)) {
      rung.add(k);
      if (t.alertAt! > now - 2 * MAX_WAIT_MS) fresh = true;
    }
  }
  if (fresh && s.productivity.reminderSound && !alarmRinging()) playAlarm(s.alarm.sound, s.alarm.volume, 0);

  const key = due.map((t) => `${t.id}:${t.alertAt}:${t.text}:${t.color}`).join("|");
  if (key !== lastKey) {
    lastKey = key;
    dueTasks.set(due);
  }
  const delay = on ? wait(nextAlert(tasks, now), now) : null;
  if (delay !== null) timeout = window.setTimeout(check, delay + 20);
}

export function startTodoReminders() {
  todos.subscribe(check);
  settings.subscribe(check);
  check();
}
