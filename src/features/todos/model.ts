// Data model of the to-dos: projects, tasks, order and the migration from the old flat list. Pure.

export const TASK_COLORS = ["red", "orange", "yellow", "green", "blue"] as const;
export type TaskColor = (typeof TASK_COLORS)[number];

export interface Project { id: string; name: string }
export interface Task {
  id: string;
  projectId: string;
  text: string;
  done: boolean;
  starred: boolean;
  color: TaskColor | null;
  /** When it is due (local time chosen by the user), null = no time. */
  due: number | null;
  /** When the reminder rings next: `due` at first, later after a snooze; null = no reminder pending. */
  alertAt: number | null;
  createdAt: number;
  doneAt: number | null;
}
export interface TodoState { projects: Project[]; active: string; tasks: Task[] }

export const DEFAULT_PROJECT: Project = { id: "personal", name: "Personal" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One saved task (old flat to-do or new task) → a valid task, or null if it has no text. */
function task(raw: unknown, projectId: string, i: number, now: number): Task | null {
  if (!isObj(raw) || typeof raw.text !== "string" || !raw.text.trim()) return null;
  const done = raw.done === true;
  const due = num(raw.due);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `t${now}-${i}`,
    projectId: typeof raw.projectId === "string" ? raw.projectId : projectId,
    text: raw.text,
    done,
    starred: raw.starred === true,
    color: TASK_COLORS.includes(raw.color as TaskColor) ? (raw.color as TaskColor) : null,
    due,
    alertAt: done ? null : "alertAt" in raw ? num(raw.alertAt) : due,
    // Old items had no time: keep their order (newest first) by counting down from now.
    createdAt: num(raw.createdAt) ?? now - i,
    doneAt: done ? (num(raw.doneAt) ?? now) : null,
  };
}

/**
 * Whatever is saved becomes a valid state. `saved` is the new store (null on first start), `legacy` the old flat
 * list (`notch:todos`), which moves into the default project once. Tasks of unknown projects go to the first one.
 */
export function migrate(saved: unknown, legacy: unknown, now: number): TodoState {
  if (isObj(saved) && Array.isArray(saved.projects)) {
    const projects = saved.projects.filter((p): p is Project => isObj(p) && typeof p.id === "string" && typeof p.name === "string");
    if (!projects.length) projects.push(DEFAULT_PROJECT);
    const ids = new Set(projects.map((p) => p.id));
    const tasks = (Array.isArray(saved.tasks) ? saved.tasks : [])
      .map((t, i) => task(t, projects[0].id, i, now))
      .filter((t): t is Task => !!t)
      .map((t) => (ids.has(t.projectId) ? t : { ...t, projectId: projects[0].id }));
    const active = typeof saved.active === "string" && ids.has(saved.active) ? saved.active : projects[0].id;
    return { projects, active, tasks };
  }
  const tasks = (Array.isArray(legacy) ? legacy : []).map((t, i) => task(t, DEFAULT_PROJECT.id, i, now)).filter((t): t is Task => !!t);
  return { projects: [DEFAULT_PROJECT], active: DEFAULT_PROJECT.id, tasks };
}

/** Starred first, then the earliest due, then the newest; done at the bottom, last done first. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due - b.due;
    return b.createdAt - a.createdAt;
  });
}

/** The task a project shows under its name: the first open one in list order. */
export function nextTask(tasks: Task[], projectId: string): Task | null {
  return sortTasks(tasks.filter((t) => t.projectId === projectId && !t.done))[0] ?? null;
}
