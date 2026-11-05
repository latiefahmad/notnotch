import { useEffect, useState } from "react";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, Row, Segmented, Switch, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { minutes, ruleFor, type NoticeRule, type NoticeSettings } from "./rules";
import { refreshStatus, requestAccess, requestFailed, setAppRule, setNoticesEnabled, sourceStatus } from "./store";

const modeText: Record<string, string> = {
  "event-log": "Aktiv · liest jede neue Mitteilung, sobald Windows sie meldet",
  polling: "Aktiv · prüft alle 5 s (Ereignisprotokoll nicht verfügbar)",
  failed: "Windows liefert keine Mitteilungen",
  off: "Aus",
};

const ruleOptions: { value: NoticeRule; label: string }[] = [
  { value: "show", label: "Zeigen" },
  { value: "mute", label: "Stumm" },
  { value: "hide", label: "Aus" },
];

const patch = (p: (n: NoticeSettings) => Partial<NoticeSettings>) => updateSettings((cur) => ({ notices: { ...cur.notices, ...p(cur.notices) } }));

/** Live notices: master switch, sources, quiet hours and the rule for each app seen. */
export function NoticesSettings() {
  const n = settings.use().notices;
  const status = sourceStatus.use();
  const failed = requestFailed.use();
  const apps = Object.entries(n.apps).sort((a, b) => a[1].localeCompare(b[1]));
  // Access may have changed in Windows Settings while NotNotch ran.
  useEffect(refreshStatus, []);

  const windowsHint =
    failed && status.access !== "allowed" ? t("Windows hat nicht gefragt: Einstellungen › Datenschutz und Sicherheit › Benachrichtigungen, Zugriff für Apps erlauben")
    : status.access === "unspecified" ? t("Windows muss den Zugriff einmal erlauben")
    : status.access === "denied" ? t("In Windows abgelehnt: Einstellungen › Datenschutz und Sicherheit › Benachrichtigungen")
    : status.access === "unavailable" ? t("Auf diesem Windows nicht verfügbar")
    : n.enabled && n.windows ? t(modeText[status.mode] ?? status.mode)
    : t("Liest Titel und Text der Mitteilungen anderer Apps, ändert nichts");

  return (
    <>
      <Group title={t("Live-Mitteilungen")} id="settings-notices">
        <Row label={t("Live-Mitteilungen")} hint={t("Mitteilungen in der geschlossenen Notch und im Verlauf. Alles bleibt auf diesem PC.")}>
          <Switch label={t("Live-Mitteilungen")} checked={n.enabled} onChange={setNoticesEnabled} />
        </Row>
        {n.enabled && (
          <>
            <Row label={t("Windows-Mitteilungen")} hint={windowsHint}>
              <div className="flex items-center gap-2">
                {status.access === "unspecified" && n.windows && <Button onClick={() => void requestAccess()}>{t("Zugriff erlauben")}</Button>}
                <Switch label={t("Windows-Mitteilungen")} checked={n.windows} onChange={(windows) => patch(() => ({ windows }))} />
              </div>
            </Row>
            <Row label="notnotch-notify" hint={
                !n.cli ? t("Für Skripte und Agent-Hooks")
                : status.pipe ? t("Bereit · für Skripte und Agent-Hooks")
                : status.pipeFailed ? t("Kanal konnte nicht geöffnet werden · belegt ein anderes Programm den Namen?")
                : t("Startet …")
              }>
              <Switch label="notnotch-notify" checked={n.cli} onChange={(cli) => patch(() => ({ cli }))} />
            </Row>
          </>
        )}
      </Group>

      {n.enabled && (
        <Group title={t("Ruhezeiten")}>
          <Row label={t("Im Präsentationsmodus")} hint={t("Mitteilungen gehen still in den Verlauf")} />
          <Row label={t("Jeden Tag")} hint={t("Zur selben Zeit still, auch über Mitternacht")}>
            <div className="flex items-center gap-1.5">
              {n.quiet.on && (
                <>
                  <TimeField value={n.quiet.from} onChange={(from) => patch((c) => ({ quiet: { ...c.quiet, from } }))} />
                  <span className="text-caption text-label-3">{t("bis")}</span>
                  <TimeField value={n.quiet.to} onChange={(to) => patch((c) => ({ quiet: { ...c.quiet, to } }))} />
                </>
              )}
              <Switch label={t("Jeden Tag")} checked={n.quiet.on} onChange={(on) => patch((c) => ({ quiet: { ...c.quiet, on } }))} />
            </div>
          </Row>
        </Group>
      )}

      {n.enabled && (
        <Group title={t("Apps")}>
          {apps.length === 0 && <Row label={t("Noch keine")} hint={t("Apps erscheinen hier mit ihrer ersten Mitteilung")} />}
          {apps.map(([id, name]) => (
            <Row key={id} label={name} hint={id === name.toLowerCase() ? undefined : id}>
              <Segmented
                id={`notice-rule-${id}`}
                size="sm"
                value={ruleFor(n.rules, id)}
                options={ruleOptions.map((o) => ({ value: o.value, label: t(o.label) }))}
                onChange={(rule) => setAppRule(id, rule)}
              />
            </Row>
          ))}
          {apps.length > 0 && <div className="px-3 py-2 text-caption text-label-3">{t("Stumm: nur im Verlauf. Aus: verworfen.")}</div>}
        </Group>
      )}
    </>
  );
}

/** "HH:MM"; saved only once it reads as a time. */
function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const save = (v: string) => {
    setDraft(v);
    if (minutes(v) !== null) onChange(v.trim().padStart(5, "0"));
  };
  return <TextField value={draft} onChange={save} placeholder="22:00" width="w-14" />;
}
