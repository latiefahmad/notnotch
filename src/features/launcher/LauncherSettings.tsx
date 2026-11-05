import { useState, type ReactNode } from "react";
import { Reorder } from "motion/react";
import { CaretDown, CaretUp, DotsSixVertical, X } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import { navigate } from "../../notch/nav";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, Row, Switch } from "../../ui/controls";
import { t } from "../../i18n";
import { moveFavorite } from "./apps";
import { slotStatus } from "./shortcuts";
import { hotkeysResting, shortcutResult, useIcons } from "./store";
import { AppIcon, HOTKEY_HINT } from "./LauncherView";

/** Settings → Tools → Launcher: order of the pinned apps (= Alt number), removing, and the shortcuts. */
export function LauncherSettings() {
  const l = settings.use().launcher;
  const favorites = l.favorites ?? [];
  const status = slotStatus(favorites, l.hotkeys, shortcutResult.use());
  const resting = hotkeysResting.use();
  const icons = useIcons(favorites.map((f) => f.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const taken = status.filter((s) => s.taken).map((s) => s.label);
  const set = (patch: Partial<typeof l>) => updateSettings((s) => ({ launcher: { ...s.launcher, ...patch } }));

  return (
    <Group title={t("Launcher")} id="settings-launcher">
      <Row
        label={t("Alt+1 bis Alt+6")}
        hint={
          taken.length
            ? t("Von einer anderen App belegt: {keys}. Diese App dort umstellen oder hier die Reihenfolge ändern.", { keys: taken.join(", ") })
            : resting
              ? t("Alt+1 bis Alt+6 ruhen, solange ein Spiel oder eine Vollbild-App läuft")
              : `${t("Startet die ersten sechs Apps aus jedem Programm.")} ${t(HOTKEY_HINT)}.`
        }
      >
        <Switch label={t("Alt+1 bis Alt+6")} checked={l.hotkeys} onChange={(hotkeys) => set({ hotkeys })} />
      </Row>
      {favorites.length === 0 ? (
        <Row label={t("Keine Apps angeheftet")}>
          <Button onClick={() => navigate("launcher")}>{t("Apps hinzufügen")}</Button>
        </Row>
      ) : (
        <Reorder.Group
          as="div"
          axis="y"
          values={favorites.map((f) => f.id)}
          onReorder={(ids: string[]) => updateSettings((s) => ({ launcher: { ...s.launcher, favorites: ids.map((id) => (s.launcher.favorites ?? []).find((f) => f.id === id)!).filter(Boolean) } }))}
          className="divide-y divide-separator"
        >
          {favorites.map((f, i) => (
            <Reorder.Item
              key={f.id}
              value={f.id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(f.id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === f.id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ms-1 text-label-4 transition-colors group-hover:text-label-3" />
              <AppIcon src={icons[f.id]} size={16} />
              <span className="min-w-0 flex-1 truncate text-body text-label select-none">{f.name}</span>
              {status[i]?.label && <span className={`tabular text-caption ${status[i].taken ? "text-red line-through" : "text-label-3"}`}>{status[i].label}</span>}
              <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center">
                <MoveButton label={t("Nach oben")} disabled={i === 0} onClick={() => set({ favorites: moveFavorite(favorites, i, -1) })}>
                  <CaretUp size={12} weight="bold" />
                </MoveButton>
                <MoveButton label={t("Nach unten")} disabled={i === favorites.length - 1} onClick={() => set({ favorites: moveFavorite(favorites, i, 1) })}>
                  <CaretDown size={12} weight="bold" />
                </MoveButton>
              </div>
              <button
                aria-label={t("Lösen")}
                title={t("Lösen")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => set({ favorites: favorites.filter((x) => x.id !== f.id) })}
                className="pressable flex size-6 items-center justify-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-2"
              >
                <X size={12} weight="bold" />
              </button>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      )}
    </Group>
  );
}

/** Keyboard way to reorder (the drag handle needs a mouse). */
function MoveButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="pressable flex size-6 items-center justify-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-2 disabled:opacity-30"
    >
      {children}
    </button>
  );
}