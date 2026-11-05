import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, MagnifyingGlass, Plus, RocketLaunch, SlidersHorizontal, SquaresFour } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { requestSize } from "../../notch/size";
import { launcher } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { Button, Empty, Skeleton, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { aiKey, searchApps, toggleFavorite, type Favorite } from "./apps";
import { slotStatus, type SlotStatus } from "./shortcuts";
import { hotkeysResting, launchError, launcherApps, loadApps, shortcutResult, showLaunchError, useIcons } from "./store";

const PICKER_SIZE = { w: 520, h: 420 };
const PICKER_LIMIT = 60;

/*
 *   [icon] [icon] [icon] [icon]  [+]
 *   Claude ChatGPT Cursor Notepad
 *   Alt+1  Alt+2   Alt+3  Alt+4
 *
 * Click starts the app. "+" (also in the header) opens the picker: every Start menu entry,
 * detected AI apps first; a click pins or unpins.
 */
export function LauncherView() {
  const l = settings.use().launcher;
  const { apps, failed } = launcherApps.use();
  const shortcuts = shortcutResult.use();
  const [picking, setPicking] = useState(false);
  const favorites = l.favorites ?? [];

  useEffect(() => void loadApps(), []);
  useEffect(() => {
    requestSize("launcher", picking ? PICKER_SIZE : null);
  }, [picking]);
  useEffect(() => () => requestSize("launcher", null), []);

  const actions = (
    <HeaderActions>
      <HeaderButton label={picking ? t("Fertig") : t("Apps hinzufügen")} active={picking} onClick={() => setPicking((p) => !p)}>
        {picking ? <Check size={14} weight="bold" /> : <Plus size={14} weight="bold" />}
      </HeaderButton>
      <HeaderButton label={t("Launcher-Einstellungen")} onClick={() => navigate("settings", "launcher")}>
        <SlidersHorizontal size={14} weight="bold" />
      </HeaderButton>
    </HeaderActions>
  );

  if (picking) {
    return (
      <>
        {actions}
        <Picker favorites={favorites} />
      </>
    );
  }
  if (favorites.length === 0) {
    return (
      <>
        {actions}
        {l.favorites === null && apps === null && !failed ? (
          <div className="flex h-full items-center gap-3 px-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="size-12 rounded-[12px]" />
            ))}
          </div>
        ) : (
          <Empty
            icon={RocketLaunch}
            title={t("Keine Apps angeheftet")}
            text={t("Hefte Apps aus dem Startmenü an. Alt+1 bis Alt+6 kannst du danach einschalten.")}
            action={<Button onClick={() => setPicking(true)}>{t("Apps hinzufügen")}</Button>}
          />
        )}
      </>
    );
  }
  return (
    <>
      {actions}
      <Grid favorites={favorites} status={slotStatus(favorites, l.hotkeys, shortcuts)} onAdd={() => setPicking(true)} />
    </>
  );
}

/** Under the tiles: a failed launch, or the Alt+N state with the one-tap opt-in. */
function Footer() {
  const { hotkeys } = settings.use().launcher;
  const error = launchError.use();
  const resting = hotkeysResting.use();
  if (error) return <div className="truncate pt-1 text-caption text-red">{error}</div>;
  if (hotkeys) return resting ? <div className="truncate pt-1 text-caption text-label-3">{t("Alt+1 bis Alt+6 ruhen, solange ein Spiel oder eine Vollbild-App läuft")}</div> : null;
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={() => updateSettings((s) => ({ launcher: { ...s.launcher, hotkeys: true } }))}
        className="pressable pressable-fill shrink-0 rounded-full bg-fill-2 px-2.5 py-0.5 text-caption font-medium text-label"
      >
        {t("Alt+1 bis Alt+6 nutzen")}
      </button>
      <span className="min-w-0 truncate text-caption text-label-3" title={t(HOTKEY_HINT)}>
        {t(HOTKEY_HINT)}
      </span>
    </div>
  );
}

export const HOTKEY_HINT = "Solange an, fehlen diese Tasten anderen Apps wie VS Code, JetBrains oder Office";

function Grid({ favorites, status, onAdd }: { favorites: Favorite[]; status: SlotStatus[]; onAdd: () => void }) {
  const icons = useIcons(favorites.map((f) => f.id));

  const start = (f: Favorite) => {
    launchError.set(null);
    launcher.open(f.id).catch((e) => showLaunchError(f.id, e));
  };

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-2">
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto [scrollbar-width:none]">
        {favorites.map((f, i) => (
          <motion.button
            key={f.id}
            onClick={() => start(f)}
            title={f.name}
            className="pressable flex w-[76px] flex-col items-center gap-1 rounded-[12px] px-1 pt-2 pb-1.5 hover:bg-fill-2"
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            transition={{ ...content.enter, delay: 0.03 * i }}
          >
            <AppIcon src={icons[f.id]} size={32} />
            <span className="w-full truncate text-center text-caption text-label">{f.name}</span>
            <ShortcutBadge status={status[i]} />
          </motion.button>
        ))}
        <button
          onClick={onAdd}
          aria-label={t("Apps hinzufügen")}
          title={t("Apps hinzufügen")}
          className="pressable flex w-[76px] flex-col items-center gap-1 rounded-[12px] px-1 pt-2 pb-1.5 text-label-3 hover:bg-fill-2 hover:text-label-2"
        >
          <span className="flex size-8 items-center justify-center rounded-[9px] border border-dashed border-current">
            <Plus size={14} weight="bold" />
          </span>
          <span className="text-caption">{t("Hinzufügen")}</span>
        </button>
      </div>
      <Footer />
    </div>
  );
}

/** "Alt+1"; red with an explanation when another app holds the key. Keeps its height when there is none. */
function ShortcutBadge({ status }: { status: SlotStatus | undefined }) {
  if (!status?.label) return <span className="h-4" />;
  return (
    <span
      title={status.taken ? t("{key} ist von einer anderen App belegt und startet diese App nicht", { key: status.label }) : undefined}
      className={`tabular h-4 rounded-[5px] px-1 text-[10px] leading-4 font-medium ${status.taken ? "bg-red/20 text-red line-through" : "bg-fill-2 text-label-3"}`}
    >
      {status.label}
    </span>
  );
}

export function AppIcon({ src, size }: { src: string | null | undefined; size: number }) {
  if (src) return <img src={src} alt="" draggable={false} className="shrink-0" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[8px] bg-fill-2 text-label-3" style={{ width: size, height: size }}>
      <SquaresFour size={size / 2} weight="bold" />
    </span>
  );
}

/** Search over every Start menu entry; a click pins or unpins. */
function Picker({ favorites }: { favorites: Favorite[] }) {
  const { apps, loading, failed } = launcherApps.use();
  const [query, setQuery] = useState("");
  const results = apps ? searchApps(apps, query, PICKER_LIMIT) : [];
  const truncated = !!apps && results.length === PICKER_LIMIT && searchApps(apps, query, Infinity).length > PICKER_LIMIT;
  const icons = useIcons(results.map((a) => a.id));
  const pinned = new Set(favorites.map((f) => f.id));

  return (
    <div className="flex h-full flex-col gap-2 px-4 pt-1 pb-2">
      <div className="flex items-center gap-2">
        <MagnifyingGlass size={14} weight="bold" className="shrink-0 text-label-3" />
        <TextField value={query} onChange={setQuery} placeholder={t("Apps durchsuchen")} width="flex-1" autoFocus />
        <Button onClick={() => void loadApps(true)} disabled={loading}>
          {t("Neu einlesen")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] bg-fill-1 [scrollbar-width:none]">
        {!apps && failed ? (
          <div className="p-3 text-caption text-label-3">{t("App-Liste nicht lesbar, Neu einlesen versuchen")}</div>
        ) : !apps ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : results.length === 0 ? (
          <div className="p-3 text-caption text-label-3">{t("Keine passende App")}</div>
        ) : (
          results.map((a) => {
            const on = pinned.has(a.id);
            return (
              <button
                key={a.id}
                aria-pressed={on}
                onClick={() => updateSettings((s) => ({ launcher: { ...s.launcher, favorites: toggleFavorite(s.launcher.favorites ?? [], a) } }))}
                className="flex h-9 w-full items-center gap-2.5 px-3 text-start hover:bg-fill-2"
              >
                <AppIcon src={icons[a.id]} size={20} />
                <span className="min-w-0 flex-1 truncate text-body text-label">{a.name}</span>
                {aiKey(a) && <span className="rounded-full bg-fill-2 px-1.5 text-caption text-label-2">{t("AI")}</span>}
                <span className={`flex size-5 items-center justify-center rounded-full ${on ? "bg-green text-black" : "bg-fill-2 text-label-3"}`}>
                  {on ? <Check size={11} weight="bold" /> : <Plus size={11} weight="bold" />}
                </span>
              </button>
            );
          })
        )}
        {truncated && <div className="px-3 py-2 text-caption text-label-3">{t("Tippen, um alle Apps zu durchsuchen")}</div>}
      </div>
    </div>
  );
}
