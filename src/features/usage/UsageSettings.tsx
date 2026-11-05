import { useRef, useState } from "react";
import { Reorder } from "motion/react";
import { Check, DotsSixVertical, PencilSimple } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import type { SecretName, UsageId } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { BrandLogo, brandName } from "../../ui/brands";
import { Group, Row, Switch, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { SecretRow } from "../settings/SettingsView";
import { NAME_MAX } from "./cards";
import { refreshUsage } from "./store";

const hints: Record<UsageId, string> = {
  claude: "Über die Anmeldung von Claude Code",
  codex: "Über die Anmeldung der Codex CLI",
  gemini: "Über die Anmeldung der Antigravity CLI",
  cursor: "Über die Anmeldung der Cursor-App",
  openrouter: "Guthaben und Ausgaben, mit API-Schlüssel",
  deepseek: "Kontostand, mit API-Schlüssel",
  zai: "Limits des Coding-Plans, mit API-Schlüssel",
};

/** Key sources and their Credential Manager entry; OpenRouter shares the AI chat's key. */
const keys: Partial<Record<UsageId, SecretName>> = { openrouter: "ai.openrouter", deepseek: "usage.deepseek", zai: "usage.zai" };

/** The AI usage cards: drag (or Alt+arrows) to reorder, switch to add or remove, pencil to rename. Keys for the API-key sources below. */
export function UsageSettings() {
  const s = settings.use();
  const { order, names } = s.aiUsage;
  const [dragging, setDragging] = useState<UsageId | null>(null);
  const [renaming, setRenaming] = useState<UsageId | null>(null);
  const [draft, setDraft] = useState("");
  // While dragging, the order lives here and is saved once on drop, not on every step.
  const [moving, setMovingState] = useState<UsageId[] | null>(null);
  const movingRef = useRef<UsageId[] | null>(null);
  const setMoving = (next: UsageId[] | null) => setMovingState((movingRef.current = next));
  const shown = moving ?? order;
  const keyed = order.filter((id) => keys[id] && s.usage[id]);

  const saveOrder = (next: UsageId[]) => updateSettings((cur) => ({ aiUsage: { ...cur.aiUsage, order: next } }));
  /** One place up (-1) or down (1). */
  const move = (id: UsageId, by: number) => {
    const i = order.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    saveOrder(next);
  };

  const commit = () => {
    if (!renaming) return;
    const name = draft.trim().slice(0, NAME_MAX);
    updateSettings((cur) => {
      const next = { ...cur.aiUsage.names };
      if (name && name !== brandName[renaming]) next[renaming] = name;
      else delete next[renaming];
      return { aiUsage: { ...cur.aiUsage, names: next } };
    });
    setRenaming(null);
  };

  return (
    <>
      <Group title={t("AI-Nutzung")} id="settings-usage">
        <Reorder.Group as="div" axis="y" values={shown} onReorder={(next: UsageId[]) => setMoving(next)} className="divide-y divide-separator">
          {shown.map((id) => {
            const on = s.usage[id];
            return (
              <Reorder.Item
                key={id}
                value={id}
                as="div"
                transition={springs.snappy}
                onDragStart={() => setDragging(id)}
                onDragEnd={() => {
                  setDragging(null);
                  if (movingRef.current) saveOrder(movingRef.current);
                  setMoving(null);
                }}
                whileDrag={{ scale: 1.02 }}
                // Alt+Up / Alt+Down on the row, or on any control in it, moves the card one place.
                tabIndex={0}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(id, e.key === "ArrowUp" ? -1 : 1);
                }}
                className={`group relative flex min-h-11 cursor-grab items-center gap-2.5 px-3 py-1.5 outline-none focus-visible:bg-fill-2 active:cursor-grabbing ${
                  dragging === id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
                }`}
              >
                <span title={t("Ziehen oder Alt+Pfeil hoch/runter zum Verschieben")} className="-ms-1 shrink-0">
                  <DotsSixVertical size={13} weight="bold" className="text-label-4 transition-colors group-hover:text-label-3" />
                </span>
                <BrandLogo id={id} size={14} className={`shrink-0 ${on ? "text-label-2" : "text-label-4"}`} />
                <div className="min-w-0 flex-1 select-none">
                  {renaming === id ? (
                    <div
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // Inside the field: Escape keeps the old name, Alt+arrows do not move the card.
                        e.stopPropagation();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    >
                      <TextField autoFocus value={draft} onChange={setDraft} onSubmit={commit} placeholder={brandName[id]} width="w-40" />
                    </div>
                  ) : (
                    <div className={`truncate text-body ${on ? "text-label" : "text-label-3"}`}>{names[id] || brandName[id]}</div>
                  )}
                  <div className="truncate text-caption text-label-3">{[names[id] && brandName[id], t(hints[id])].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    aria-label={renaming === id ? t("Sichern") : t("Umbenennen")}
                    title={renaming === id ? t("Sichern") : t("Umbenennen")}
                    onClick={() => {
                      if (renaming === id) return commit();
                      setDraft(names[id] ?? "");
                      setRenaming(id);
                    }}
                    className={`pressable flex size-6 items-center justify-center rounded-full text-label-3 hover:text-label-2 ${renaming === id ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                  >
                    {renaming === id ? <Check size={12} weight="bold" /> : <PencilSimple size={12} weight="bold" />}
                  </button>
                  <Switch label={names[id] || brandName[id]} checked={on} onChange={(v) => updateSettings((cur) => ({ usage: { ...cur.usage, [id]: v } }))} />
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
        <Row
          label={
            <span className="flex items-center gap-2 text-label-3">
              <BrandLogo id="grok" size={14} /> {brandName.grok}
            </span>
          }
          hint={t("xAI bietet keinen Abruf der Abo-Limits")}
        >
          <span className="text-caption text-label-4">{t("Nicht verfügbar")}</span>
        </Row>
      </Group>
      {keyed.length > 0 && (
        <Group title={t("Schlüssel für die AI-Nutzung")}>
          {keyed.map((id) => (
            // Saving a key asks the source again at once, so an old "no key" or "key rejected" does not linger.
            <SecretRow key={id} name={keys[id]!} label={names[id] || brandName[id]} hint={id === "openrouter" ? t("Derselbe Schlüssel wie im AI-Chat") : undefined} onSaved={() => void refreshUsage()} />
          ))}
        </Group>
      )}
    </>
  );
}
