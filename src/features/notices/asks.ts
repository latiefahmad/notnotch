// Questions from `notnotch-notify ask`, waiting for a click in the closed notch. Pure; `tr` is passed in so this stays free of i18n.

/** One question as Rust sends it (`notices://ask`). */
export interface Ask {
  id: number;
  appId: string;
  appName: string;
  title: string;
  body: string;
  /** Option ids in button order, checked by Rust: at most four of a-z, 0-9 and -. */
  options: string[];
  /** Milliseconds since 1970. */
  at: number;
}

/** Adds a question; the oldest (lowest id, as Rust counts) stays first, whatever order the events arrive in. */
export function addAsk(list: Ask[], a: Ask): Ask[] {
  return [...list.filter((x) => x.id !== a.id), a].sort((x, y) => x.id - y.id);
}

export function removeAsk(list: Ask[], id: number): Ask[] {
  return list.filter((a) => a.id !== id);
}

type Tr = (de: string) => string;

/** The button label: the three standard ids are translated, any other id shows as given. */
export function optionLabel(id: string, tr: Tr): string {
  if (id === "allow") return tr("Erlauben");
  if (id === "always") return tr("Immer erlauben");
  if (id === "deny") return tr("Ablehnen");
  return id;
}
