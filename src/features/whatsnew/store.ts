import { markSeen, useUnseen } from "../../lib/changelog";
import { createStore } from "../../lib/store";
import { update } from "../../lib/update";
import { whatsNew, type WhatsNew } from "./model";

/** An offered version the user waved away: no notice for it again, the next one gets its own. */
const dismissed = createStore<string | null>(null, { persist: "update-dismissed" });

/** The notice the page was opened from; the page marks it seen, so it keeps its own copy. */
export const opened = createStore<WhatsNew>(null);

export function useWhatsNew(): WhatsNew {
  const unseen = useUnseen();
  const u = update.use();
  return whatsNew({ available: u.phase === "available" ? u.version : null, dismissed: dismissed.use(), unseen: unseen[0]?.version ?? null });
}

/** The ✕ on the notice, or the page it opens: either way it has been seen. */
export function dismissWhatsNew(news: NonNullable<WhatsNew>) {
  if (news.kind === "updated") markSeen();
  else dismissed.set(news.version);
}
