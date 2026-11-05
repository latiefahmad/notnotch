import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  Check,
  CheckSquare,
  ClipboardText,
  Copy,
  File,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  ImageSquare,
  Table,
  TextT,
  Trash,
  Tray,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { fade, springs } from "../../design/motion";
import { createStore } from "../../lib/store";
import { formatBytes } from "../../lib/format";
import { drop, pasteFiles, takeDropped, usePasteFiles } from "../../platform/drop";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { clipboardText, copyFiles, filePreview, openFile, probeFiles, revealFile, shelfDragOut, type FileKind } from "../../platform/services";
import { addFiles, addText, dragPayload, isText, keyOf, normalizeItems, removeKeys, type FileItem, type ShelfItem, type TextItem } from "./model";
import { NONE, clickSelect, dragKeys, prune, type Selection } from "./selection";
import { t } from "../../i18n";
import { usePresenting } from "../privacy/store";
import { Redacted } from "../../ui/controls";

/*
 * Shelf: put files on the notch and later open them with one click, show them in Explorer,
 * paste them elsewhere with Ctrl+V or drag them out into another app. Only references are
 * stored; the files stay where they are. Text cards keep a snippet: click copies it, dragging
 * gives the text.
 *
 * Files come in via drag and drop or Ctrl+V (screenshots too), text via drop on the open
 * shelf or Ctrl+V. Anything dropped on the closed notch lands here.
 *
 * Select several: Ctrl+click, Shift+click or the select button; then drag, copy or remove
 * them together.
 */
const shelf = createStore<ShelfItem[]>([], { persist: "shelf" });
shelf.set(normalizeItems);

/** A drag out of the shelf is running: its own drop overlay and drops back stay quiet. */
const draggingOut = createStore(false);

/** Movement in px before a press on a card becomes a drag. */
const DRAG_START = 6;

/** Puts files at the front of the Shelf (also used by Capture for new screenshots). */
export function addToShelf(paths: string[]) {
  void probeFiles(paths).then(({ files }) => shelf.set((list) => addFiles(list, files, Date.now())));
}

const kindIcon: Record<FileKind, Icon> = { image: ImageSquare, audio: FileAudio, video: FileVideo, document: FileText, table: Table, other: File };

const newTextId = () => `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function keepText(text: string) {
  shelf.set((list) => addText(list, text, Date.now(), newTextId()));
}

/** Ctrl+V or the paste button: files or an image first, otherwise text becomes a card. */
async function pasteTextFallback(): Promise<boolean> {
  const text = await clipboardText();
  if (!text.trim()) return false;
  keepText(text);
  return true;
}

const isTextDrag = (e: DragEvent) => {
  const types = e.dataTransfer.types;
  return types.includes("text/plain") && !types.includes("Files");
};

export function ShelfView() {
  const items = shelf.use();
  // Shared or recorded screen: text cards show no text, not even to a screen reader's label.
  const presenting = usePresenting();
  const { dragging, dropped } = drop.use();
  const out = draggingOut.use();
  const [copied, setCopied] = useState<string | null>(null);
  const [nothing, setNothing] = useState(false);
  const [textOver, setTextOver] = useState(false);
  const [selecting, setSelecting] = useState(false);
  /** Last drag out error (e.g. the files are gone), shown briefly in the header. */
  const [failed, setFailed] = useState<string | null>(null);
  const [rawSel, setSel] = useState<Selection>(NONE);
  const order = items.map(keyOf);
  const sel = prune(rawSel, order);
  const press = useRef<{ x: number; y: number; key: string } | null>(null);
  const swallowClick = useRef(false);

  usePasteFiles(() => void pasteTextFallback().then((ok) => !ok && flash(setNothing)));

  useEffect(() => {
    const paths = takeDropped();
    // A file dragged out and dropped back on the notch is already here and keeps its place.
    if (paths?.length) addToShelf(paths);
  }, [dropped]);

  const flashCopied = (key: string) => {
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };

  const copyKeys = async (keys: string[], flashKey: string) => {
    const { paths, text } = dragPayload(items, keys);
    if (paths.length) await copyFiles(paths);
    else if (text !== null) await navigator.clipboard.writeText(text);
    else return;
    flashCopied(flashKey);
  };

  const clearSelection = () => {
    setSel(NONE);
    setSelecting(false);
  };

  // Drag out: press, move a few px with the button held, then Windows takes over until the drop.
  const onPointerDown = (e: PointerEvent, key: string) => {
    swallowClick.current = false;
    press.current = e.button === 0 ? { x: e.clientX, y: e.clientY, key } : null;
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || !(e.buttons & 1) || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return;
    press.current = null;
    swallowClick.current = true;
    const { paths, text } = dragPayload(items, dragKeys(sel, p.key));
    if (!paths.length && text === null) return;
    draggingOut.set(true);
    void shelfDragOut(paths, text)
      .catch((e: unknown) => {
        setFailed(String(e));
        setTimeout(() => setFailed(null), 2400);
      })
      // The drop back on the notch reaches the page a moment after the drag ends.
      .finally(() => setTimeout(() => draggingOut.set(false), 500));
  };

  // Modifier clicks and select mode pick cards instead of opening or copying them.
  const onClickCapture = (e: MouseEvent, key: string) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      e.stopPropagation();
      return;
    }
    const toggle = e.ctrlKey || e.metaKey || selecting;
    if ((!toggle && !e.shiftKey) || (e.target as Element).closest("[data-remove]")) return;
    e.stopPropagation();
    e.preventDefault();
    setSel(clickSelect(sel, order, key, { toggle, range: e.shiftKey }));
  };

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!isTextDrag(e) || draggingOut.get()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setTextOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTextOver(false);
    },
    onDrop: (e: DragEvent) => {
      setTextOver(false);
      if (!isTextDrag(e) || draggingOut.get()) return;
      e.preventDefault();
      keepText(e.dataTransfer.getData("text/plain"));
    },
  };

  const over = (dragging || textOver) && !out;

  if (items.length === 0) {
    return (
      <div className="h-full px-4 pt-1 pb-2" {...dropHandlers}>
        <motion.div
          className={`flex h-full flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed transition-colors duration-200 ${
            over ? "border-label-2 bg-fill-2" : "border-fill-3 bg-fill-1"
          }`}
          animate={{ transform: over ? "scale(1.015)" : "scale(1)" }}
          transition={springs.snappy}
        >
          <Tray size={22} weight="bold" className={over ? "text-label" : "text-label-3"} />
          <span className="text-body text-label-2">{over ? t("Loslassen zum Ablegen") : t("Dateien oder Text hierher ziehen")}</span>
          <PasteHint nothing={nothing} onPaste={() => void pasteAny().then((ok) => !ok && flash(setNothing))} />
        </motion.div>
      </div>
    );
  }

  const picked = sel.keys.length;

  return (
    <div className="relative flex h-full flex-col px-4 pt-1 pb-2" {...dropHandlers}>
      <HeaderActions>
        {failed !== null && (
          <span role="alert" title={failed} className="me-1 text-caption text-red">
            {t("Ziehen fehlgeschlagen")}
          </span>
        )}
        {picked > 0 ? (
          <>
            <span className="tabular me-1 text-caption text-label-2">{t("{n} ausgewählt", { n: picked })}</span>
            <HeaderButton label={copied === "picked" ? t("Kopiert") : t("Auswahl kopieren")} onClick={() => void copyKeys(sel.keys, "picked")}>
              {copied === "picked" ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
            </HeaderButton>
            <HeaderButton label={t("Auswahl entfernen")} onClick={() => shelf.set((l) => removeKeys(l, sel.keys))}>
              <Trash size={14} weight="bold" />
            </HeaderButton>
            <HeaderButton label={t("Auswahl aufheben")} onClick={clearSelection}>
              <X size={14} weight="bold" />
            </HeaderButton>
          </>
        ) : (
          <>
            <span className="tabular me-1 text-caption text-label-3">
              {items.length} {items.length === 1 ? t("Eintrag") : t("Einträge")}
            </span>
            <HeaderButton label={selecting ? t("Auswählen beenden") : t("Auswählen")} active={selecting} onClick={() => (selecting ? clearSelection() : setSelecting(true))}>
              <CheckSquare size={14} weight="bold" />
            </HeaderButton>
            <HeaderButton label={copied === "all" ? t("Kopiert") : t("Alle kopieren")} onClick={() => void copyKeys(order, "all")}>
              {copied === "all" ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
            </HeaderButton>
            <HeaderButton label={t("Ablage leeren")} onClick={() => shelf.set([])}>
              <Trash size={14} weight="bold" />
            </HeaderButton>
          </>
        )}
      </HeaderActions>
      <div role="listbox" aria-multiselectable="true" aria-label={t("Ablage")} className="flex min-h-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => {
            const key = keyOf(item);
            const on = sel.keys.includes(key);
            return (
              <motion.div
                key={key}
                layout
                transition={springs.snappy}
                initial={{ opacity: 0, transform: "scale(0.94)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.94)", transition: fade }}
                className="group relative h-full w-[112px] shrink-0"
                onPointerDown={(e) => onPointerDown(e, key)}
                onPointerMove={onPointerMove}
                onPointerUp={() => (press.current = null)}
                onClickCapture={(e) => onClickCapture(e, key)}
                role="option"
                aria-selected={on}
                aria-label={isText(item) ? (presenting ? t("Text") : item.text.slice(0, 80)) : item.name}
              >
                {isText(item) ? (
                  <TextCard item={item} hidden={presenting} copied={copied === key} onCopy={() => void copyKeys([key], key)} />
                ) : (
                  <FileCard item={item} copied={copied === key} onCopy={() => void copyKeys([key], key)} />
                )}
                <span
                  className={`pointer-events-none absolute inset-0 rounded-[14px] ring-2 transition-opacity duration-150 ring-inset ${
                    on ? "opacity-100 ring-label-2" : "opacity-0 ring-transparent"
                  }`}
                />
                {(selecting || picked > 0) && (
                  <span
                    className={`pointer-events-none absolute top-1.5 start-1.5 flex size-5 items-center justify-center rounded-full backdrop-blur-md ${
                      on ? "bg-label text-notch" : "bg-fill-3 text-transparent"
                    }`}
                  >
                    <Check size={10} weight="bold" />
                  </span>
                )}
                <button
                  data-remove
                  aria-label={t("Entfernen")}
                  onClick={() => shelf.set((l) => removeKeys(l, [key]))}
                  className="pressable absolute top-1.5 end-1.5 flex size-5 items-center justify-center rounded-full bg-fill-3 text-label-2 opacity-0 backdrop-blur-md group-hover:opacity-100 hover:text-label"
                >
                  <X size={10} weight="bold" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {over && (
          <motion.div
            className="pointer-events-none absolute inset-x-4 top-1 bottom-3 flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-label-2 bg-black/70 text-body text-label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            {t("Loslassen zum Ablegen")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

async function pasteAny(): Promise<boolean> {
  return (await pasteFiles()) || (await pasteTextFallback());
}

function FileCard({ item, copied, onCopy }: { item: FileItem; copied: boolean; onCopy: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const I = kindIcon[item.kind];
  const hidden = usePresenting();
  useEffect(() => {
    if (item.kind === "image") void filePreview(item.path).then(setPreview);
  }, [item.path, item.kind]);

  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button
        onClick={() => void openFile(item.path)}
        title={t("{name} öffnen", { name: item.name })}
        className="pressable relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        {preview && !hidden ? (
          <img src={preview} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
        ) : (
          <I size={30} weight="duotone" className="text-label-2" />
        )}
      </button>
      <div className="px-2 pt-1.5 pb-1">
        <p className="truncate text-caption font-medium text-label" title={item.name}>{item.name}</p>
        <div className="flex items-center justify-between">
          <span className="tabular text-caption text-label-3">{formatBytes(item.size, 0)}</span>
          <span className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <IconBtn label={t("Im Explorer zeigen")} icon={FolderOpen} onClick={() => revealFile(item.path)} />
            <IconBtn label={copied ? t("Kopiert") : t("Kopieren")} icon={copied ? Check : Copy} onClick={onCopy} />
            <IconBtn label={t("Öffnen")} icon={ArrowSquareOut} onClick={() => void openFile(item.path)} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** A kept snippet: click copies it, dragging it out gives the text. */
function TextCard({ item, hidden, copied, onCopy }: { item: TextItem; hidden: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button onClick={onCopy} title={t("Klicken zum Kopieren")} className="pressable flex min-h-0 flex-1 items-start overflow-hidden px-2.5 pt-2.5 text-start">
        {hidden ? <Redacted lines={4} /> : <p className="line-clamp-6 text-caption break-words whitespace-pre-wrap text-label-2">{item.text}</p>}
      </button>
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
        <span className="flex items-center gap-1 text-caption text-label-3">
          <TextT size={12} weight="bold" />
          <span className="tabular">{t("{n} Zeichen", { n: item.text.length })}</span>
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "done" : "copy"}
            className={`flex ${copied ? "text-green" : "text-label-3 opacity-0 group-hover:opacity-100"}`}
            initial={{ opacity: 0, transform: "scale(0.6)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.6)" }}
            transition={fade}
          >
            {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Second path besides drag and drop, visible because Ctrl+V isn't discoverable. */
export function PasteHint({ nothing, onPaste }: { nothing: boolean; onPaste?: () => void }) {
  return (
    <button onClick={onPaste ?? (() => void pasteFiles())} className="pressable flex items-center gap-1 text-caption text-label-3 hover:text-label-2">
      <ClipboardText size={12} weight="bold" />
      {nothing ? t("Keine Dateien in der Zwischenablage") : t("oder Strg+V zum Einfügen")}
    </button>
  );
}

function flash(set: (v: boolean) => void) {
  set(true);
  setTimeout(() => set(false), 1600);
}

function IconBtn({ label, icon: I, onClick }: { label: string; icon: Icon; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="pressable flex size-5 items-center justify-center text-label-3 hover:text-label">
      <I size={12} weight="bold" />
    </button>
  );
}
