import { useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { secrets } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, Row, Segmented, Select, Switch, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { HORIZONS, PALETTE, linkHost, newSourceId, nextColor, type CalendarSettings as Config, type CalendarSource } from "./model";
import { calendar } from "./store";
import { calendarError } from "./CalendarView";

type Draft = { id: string | null; kind: "ics" | "caldav"; name: string; color: string; url: string; user: string; secret: string };

const setCalendar = (patch: (c: Config) => Partial<Config>) => updateSettings((s) => ({ calendar: { ...s.calendar, ...patch(s.calendar) } }));

const horizonLabel = (m: number) => (m < 60 ? t("{n} Min.", { n: m }) : t("{n} Std.", { n: m / 60 }));

/** Settings → Connections → Calendar: ICS links and CalDAV accounts, the notice before an event and the next-event part's horizon. */
export function CalendarSettings() {
  const c = settings.use().calendar;
  const status = calendar.use().data?.sources ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);

  const edit = (s: CalendarSource) => setDraft({ id: s.id, kind: s.kind, name: s.name, color: s.color, url: s.url, user: s.user, secret: "" });
  const remove = (id: string) => {
    void secrets.set(`calendar.${id}`, "");
    setCalendar((cur) => ({ sources: cur.sources.filter((s) => s.id !== id) }));
    if (draft?.id === id) setDraft(null);
  };

  return (
    <Group title={t("Kalender")} id="settings-calendar">
      {c.sources.map((s) => {
        const error = status.find((x) => x.id === s.id)?.error;
        const where = s.kind === "ics" ? s.host : `${s.user} · ${linkHost(s.url)}`;
        return (
          <Row
            key={s.id}
            label={
              <span className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                {s.name || where || t("Kalender")}
              </span>
            }
            hint={error ? <span className="text-orange">{t(calendarError[error] ?? "Abruf fehlgeschlagen")}</span> : `${s.kind === "ics" ? t("ICS-Link") : "CalDAV"} · ${where}`}
          >
            <div className="flex items-center gap-1.5">
              <Button onClick={() => edit(s)}>{t("Bearbeiten")}</Button>
              <button aria-label={t("Entfernen")} onClick={() => remove(s.id)} className="pressable rounded-full p-1 text-label-3 hover:text-label-2">
                <X size={13} weight="bold" />
              </button>
            </div>
          </Row>
        );
      })}
      {draft ? (
        <SourceForm draft={draft} onChange={setDraft} onDone={() => setDraft(null)} />
      ) : (
        <Row label={c.sources.length ? "" : t("Noch kein Kalender")} hint={c.sources.length ? undefined : t("Nur lesen: NotNotch ändert keine Termine")}>
          <Button icon={Plus} onClick={() => setDraft({ id: null, kind: "ics", name: "", color: nextColor(c.sources), url: "", user: "", secret: "" })}>
            {t("Kalender hinzufügen")}
          </Button>
        </Row>
      )}
      <Row label={t("Mitteilung vor Terminen")} hint={t("In der geschlossenen Notch, bis der Termin beginnt")}>
        <div className="flex items-center gap-2">
          {c.notice && (
            <Segmented
              id="calendar-notice"
              size="sm"
              value={String(c.noticeMin) as "5" | "10"}
              onChange={(v) => setCalendar(() => ({ noticeMin: v === "5" ? 5 : 10 }))}
              options={[
                { value: "5", label: t("{n} Min.", { n: 5 }) },
                { value: "10", label: t("{n} Min.", { n: 10 }) },
              ]}
            />
          )}
          <Switch label={t("Mitteilung vor Terminen")} checked={c.notice} onChange={(notice) => setCalendar(() => ({ notice }))} />
        </div>
      </Row>
      <Row label={t("Nächster Termin in der Notch")} hint={t("Ab so viel vorher; den Teil unter Darstellung einschalten")}>
        <Select
          value={String(c.horizonMin)}
          options={HORIZONS.map((m) => ({ value: String(m), label: horizonLabel(m) }))}
          onChange={(v) => setCalendar(() => ({ horizonMin: Number(v) }))}
          width="w-24"
        />
      </Row>
    </Group>
  );
}

function SourceForm({ draft: d, onChange, onDone }: { draft: Draft; onChange: (d: Draft) => void; onDone: () => void }) {
  const set = (patch: Partial<Draft>) => onChange({ ...d, ...patch });
  const isNew = d.id === null;
  // A new source needs its secret; an edited one keeps the stored one when the field stays empty.
  const valid = d.kind === "ics" ? (isNew ? !!linkHost(d.secret) : !d.secret.trim() || !!linkHost(d.secret)) : !!linkHost(d.url) && !!d.user.trim() && (!isNew || !!d.secret.trim());

  const save = async () => {
    if (!valid) return;
    const sources = settings.get().calendar.sources;
    const id = d.id ?? newSourceId(sources.map((s) => s.id));
    const before = sources.find((s) => s.id === id);
    // The secret first: the settings change starts a fetch, which reads it.
    if (d.secret.trim()) await secrets.set(`calendar.${id}`, d.secret.trim());
    const host = d.kind === "ics" ? (d.secret.trim() ? linkHost(d.secret) : (before?.host ?? "")) : "";
    const source: CalendarSource = { id, kind: d.kind, name: d.name.trim(), color: d.color, url: d.kind === "caldav" ? d.url.trim() : "", user: d.kind === "caldav" ? d.user.trim() : "", host };
    setCalendar((cur) => ({ sources: before ? cur.sources.map((s) => (s.id === id ? source : s)) : [...cur.sources, source] }));
    onDone();
  };

  return (
    <div className="bg-fill-1">
      {isNew && (
        <Row label={t("Art")}>
          <Segmented
            id="calendar-kind"
            size="sm"
            value={d.kind}
            onChange={(kind) => set({ kind, secret: "" })}
            options={[
              { value: "ics", label: t("ICS-Link") },
              { value: "caldav", label: "CalDAV" },
            ]}
          />
        </Row>
      )}
      {d.kind === "ics" ? (
        <Row
          label={t("Link")}
          hint={t("Die geheime iCal-Adresse aus Google, Outlook oder iCloud; liegt in der Anmeldeinformationsverwaltung")}
        >
          <TextField secret value={d.secret} onChange={(secret) => set({ secret })} placeholder={isNew ? "webcal://…" : t("Gespeichert")} width="w-52" onSubmit={() => void save()} autoFocus />
        </Row>
      ) : (
        <>
          <Row label={t("Server")} hint={t("z. B. https://caldav.icloud.com oder die Adresse des Kalenders")}>
            <TextField value={d.url} onChange={(url) => set({ url })} placeholder="https://…" width="w-52" autoFocus />
          </Row>
          <Row label={t("Nutzername")}>
            <TextField value={d.user} onChange={(user) => set({ user })} width="w-52" />
          </Row>
          <Row label={t("App-Passwort")} hint={t("Ein App-Passwort, nicht das Konto-Passwort; liegt in der Anmeldeinformationsverwaltung")}>
            <TextField secret value={d.secret} onChange={(secret) => set({ secret })} placeholder={isNew ? "" : t("Gespeichert")} width="w-52" onSubmit={() => void save()} />
          </Row>
        </>
      )}
      <Row label={t("Name")} hint={t("Optional")}>
        <TextField value={d.name} onChange={(name) => set({ name })} width="w-52" />
      </Row>
      <Row label={t("Farbe")} hint={d.kind === "caldav" ? t("Für Kalender ohne eigene Farbe") : undefined}>
        <div className="flex gap-1.5" role="radiogroup" aria-label={t("Farbe")}>
          {PALETTE.map((color) => (
            <button
              key={color}
              role="radio"
              aria-checked={d.color === color}
              aria-label={color}
              onClick={() => set({ color })}
              className={`pressable size-4 rounded-full ${d.color === color ? "ring-2 ring-label ring-offset-1 ring-offset-transparent" : ""}`}
              style={{ background: color }}
            />
          ))}
        </div>
      </Row>
      <Row label="">
        <div className="flex gap-1.5">
          <Button onClick={onDone}>{t("Abbrechen")}</Button>
          <Button primary disabled={!valid} onClick={() => void save()}>
            {t("Sichern")}
          </Button>
        </div>
      </Row>
    </div>
  );
}
