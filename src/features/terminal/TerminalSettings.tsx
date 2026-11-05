import { useEffect, useState } from "react";
import { terminal } from "../../platform/services";
import { settings, updateSettings, type Settings } from "../../settings/store";
import { Button, Group, Row, Select, Slider, Switch, TextField } from "../../ui/controls";
import { t } from "../../i18n";

type Prefs = Settings["terminal"];

const shells: { value: Prefs["shell"]; label: string }[] = [
  { value: "pwsh", label: "PowerShell 7" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Eingabeaufforderung" },
];

/** Settings → Tools → Terminal. Shell and folder apply to the next session, the font size right away. */
export function TerminalSettings() {
  const prefs = settings.use().terminal;
  const [dir, setDir] = useState(prefs.startDir);
  const [hasPwsh, setHasPwsh] = useState(true);
  const set = (patch: Partial<Prefs>) => updateSettings((s) => ({ terminal: { ...s.terminal, ...patch } }));
  const saveDir = () => set({ startDir: dir.trim() });

  useEffect(() => {
    void terminal.info().then((i) => setHasPwsh(!!i.pwsh), () => {});
  }, []);

  return (
    <Group title={t("Terminal")} id="settings-terminal">
      <Row
        label={t("Shell")}
        hint={prefs.shell === "pwsh" && !hasPwsh ? t("PowerShell 7 nicht gefunden, startet Windows PowerShell") : t("Gilt ab der nächsten Sitzung")}
      >
        <Select width="w-44" value={prefs.shell} onChange={(shell) => set({ shell })} options={shells.map((o) => ({ ...o, label: t(o.label) }))} />
      </Row>
      <Row label={t("Schriftgröße")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Schriftgröße")} value={prefs.fontSize} min={10} max={18} step={1} onChange={(fontSize) => set({ fontSize })} />
          <span className="tabular w-8 text-end text-caption text-label-2">{prefs.fontSize}</span>
        </div>
      </Row>
      <Row label={t("Startordner")} hint={t("Leer = Benutzerordner, ~ steht für ihn")}>
        <div className="flex items-center gap-1.5">
          <TextField value={dir} onChange={setDir} onSubmit={saveDir} placeholder="~" width="w-44" />
          {dir.trim() !== prefs.startDir && <Button onClick={saveDir}>{t("Sichern")}</Button>}
        </div>
      </Row>
      <Row label={t("Beim Schließen beenden")} hint={t("Sonst läuft die Sitzung weiter, wenn die Notch zugeht")}>
        <Switch label={t("Beim Schließen beenden")} checked={prefs.endOnClose} onChange={(endOnClose) => set({ endOnClose })} />
      </Row>
    </Group>
  );
}
