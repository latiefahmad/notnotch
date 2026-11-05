import { useEffect, useState } from "react";
import { FileZip, FolderOpen, PuzzlePiece, X } from "@phosphor-icons/react";
import { isNative } from "../../platform/native";
import type { StagedPlugin } from "../../platform/services";
import { settings } from "../../settings/store";
import { Button, Group, Row, Switch } from "../../ui/controls";
import { t } from "../../i18n";
import { iconFor } from "./icons";
import { toolId, type PluginManifest } from "./model";
import { cancelInstall, confirmInstall, install, pickPlugin, plugins, refreshPlugins, removePlugin, setPluginEnabled } from "./store";

/** Install errors from Rust (plugins.rs), some with the file name after a colon. */
const errors: Record<string, string> = {
  "not-found": "Ordner oder Datei nicht gefunden",
  "no-manifest": "Keine notnotch-plugin.json gefunden",
  "manifest-json": "notnotch-plugin.json ist ungültig",
  "manifest-size": "notnotch-plugin.json ist zu groß",
  id: "Ungültige Plugin-ID",
  name: "Ungültiger Name",
  version: "Ungültige Version (erwartet 1.2.3)",
  author: "Ungültiger Autor",
  description: "Ungültige Beschreibung",
  icon: "Unbekanntes Symbol",
  entry: "Ungültige Startseite",
  size: "Größe außerhalb der Grenzen",
  domain: "Ungültige Domain",
  "too-many-domains": "Zu viele Domains",
  "no-entry": "Die Startseite fehlt",
  path: "Unzulässiger Dateiname",
  symlink: "Verknüpfungen sind nicht erlaubt",
  "too-large": "Zu groß",
  "too-many-files": "Zu viele Dateien",
  "file-type": "Dateityp nicht erlaubt",
  duplicate: "Doppelter Dateiname",
  zip: "ZIP nicht lesbar",
  read: "Nicht lesbar",
  write: "Konnte nicht gespeichert werden",
  "in-use": "Gerade in Benutzung, gleich erneut versuchen",
  expired: "Abgelaufen, bitte erneut auswählen",
};

function errorText(e: string): string {
  const [code, ...rest] = e.split(":");
  const text = t(errors[code] ?? "Installation fehlgeschlagen");
  return rest.length ? `${text}: ${rest.join(":")}` : text;
}

/** One line on what a plugin may do. */
function permissionSummary(m: PluginManifest): string {
  const p = m.permissions;
  const parts = [...p.network, ...(p.storage ? [t("Eigene Daten")] : []), ...(p.notices ? [t("Mitteilungen")] : [])];
  return parts.length ? parts.join(" · ") : t("Keine Berechtigungen");
}

/** Settings → Plugins: the installed plugins, install from a folder or .zip, and the confirmation with the permissions. */
export function PluginSettings() {
  const list = plugins.use();
  const tools = settings.use().tools;
  const state = install.use();
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => void refreshPlugins(), []);

  if (!isNative) {
    return (
      <Group title={t("Plugins")} id="settings-plugins">
        <Row label={t("Plugins laufen nur in der App")} />
      </Group>
    );
  }

  return (
    <>
      <Group title={t("Plugins")} id="settings-plugins">
        {list.map((m) => {
          const I = iconFor(m.icon) ?? PuzzlePiece;
          const on = tools.some((x) => x.id === toolId(m.id) && x.enabled);
          return (
            <Row
              key={m.id}
              label={
                <span className="flex items-center gap-2">
                  <I size={14} weight="bold" className="shrink-0 text-label-2" />
                  {m.name}
                  <span className="text-label-3">{m.version}</span>
                </span>
              }
              hint={permissionSummary(m)}
            >
              <div className="flex items-center gap-2">
                {removing === m.id ? (
                  <>
                    <Button onClick={() => setRemoving(null)}>{t("Abbrechen")}</Button>
                    <Button onClick={() => void removePlugin(m.id).then(() => setRemoving(null))}>{t("Mit Daten entfernen")}</Button>
                  </>
                ) : (
                  <button aria-label={t("Entfernen")} onClick={() => setRemoving(m.id)} className="pressable rounded-full p-1 text-label-3 hover:text-label-2">
                    <X size={13} weight="bold" />
                  </button>
                )}
                <Switch label={m.name} checked={on} onChange={(v) => setPluginEnabled(m.id, v)} />
              </div>
            </Row>
          );
        })}
        {state.phase === "confirm" && state.staged ? (
          <Confirm staged={state.staged} />
        ) : (
          <Row
            label={list.length ? t("Plugin hinzufügen") : t("Noch kein Plugin")}
            hint={state.error ? <span className="text-orange">{errorText(state.error)}</span> : t("Ein Ordner oder eine .zip mit notnotch-plugin.json")}
          >
            <div className="flex items-center gap-1.5">
              <Button icon={FolderOpen} disabled={state.phase !== "idle"} onClick={() => void pickPlugin(false)}>{t("Ordner …")}</Button>
              <Button icon={FileZip} disabled={state.phase !== "idle"} onClick={() => void pickPlugin(true)}>{t("ZIP …")}</Button>
            </div>
          </Row>
        )}
      </Group>
      <p className="px-3 text-caption text-label-3">
        {t("Plugins laufen abgeschirmt: kein Zugriff auf Dateien, Schlüssel, Tresor, Zwischenablage, andere Plugins oder die Einstellungen. Ins Netz nur zu den Adressen, die sie hier nennen.")}
      </p>
    </>
  );
}

/** What the plugin is and may do, before anything is installed. */
function Confirm({ staged }: { staged: StagedPlugin }) {
  const m = staged.manifest;
  const p = m.permissions;
  const I = iconFor(m.icon) ?? PuzzlePiece;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <I size={16} weight="bold" className="shrink-0 text-label-2" />
        <span className="text-body text-label">{m.name}</span>
        <span className="text-caption text-label-3">
          {m.version}
          {m.author && ` · ${m.author}`}
        </span>
      </div>
      {m.description && <p className="text-caption text-label-2">{m.description}</p>}
      <ul className="flex flex-col gap-0.5 text-caption text-label-2">
        {p.network.length > 0 ? (
          <li>{t("Darf diese Adressen abrufen: {list}", { list: p.network.join(", ") })}</li>
        ) : (
          <li>{t("Kein Netz")}</li>
        )}
        {p.storage && <li>{t("Speichert eigene Daten auf diesem PC")}</li>}
        {p.notices && <li>{t("Darf Mitteilungen in der Notch zeigen")}</li>}
        {staged.replaces && <li className="text-orange">{t("Ersetzt die installierte Version {v}, die Daten bleiben", { v: staged.replaces })}</li>}
      </ul>
      <div className="flex justify-end gap-1.5">
        <Button onClick={cancelInstall}>{t("Abbrechen")}</Button>
        <Button primary onClick={() => void confirmInstall()}>{t("Installieren")}</Button>
      </div>
    </div>
  );
}
