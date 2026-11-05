import { useState } from "react";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, Row, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { SecretRow } from "../settings/SettingsView";
import { github, refreshGithub } from "./store";

/** Settings → Connections → GitHub: the username, and an optional token for the API. */
export function GithubSettings() {
  const saved = settings.use().github.user;
  const rejected = github.use().error === "token-rejected";
  const [user, setUser] = useState(saved);
  // Pasting a profile URL works too: only the name is kept.
  const clean = user.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
  const save = () => updateSettings((s) => ({ github: { ...s.github, user: clean } }));
  return (
    <Group title="GitHub" id="settings-github">
      <Row label={t("Nutzername")} hint={t("Liest die öffentliche Beitragsseite, einmal pro Stunde")}>
        <div className="flex items-center gap-1.5">
          <TextField value={user} onChange={setUser} onSubmit={save} placeholder="octocat" width="w-40" />
          {clean !== saved && <Button onClick={save}>{t("Sichern")}</Button>}
        </div>
      </Row>
      <SecretRow
        name="github.token"
        label={t("Token (optional)")}
        hint={
          rejected
            ? t("GitHub hat diesen Token abgelehnt: ersetzen oder löschen")
            : t("Nur falls die Seite nicht lesbar ist: ein Token ohne Rechte reicht, gelesen wird über die GraphQL-API")
        }
        onSaved={() => void refreshGithub(true)}
      />
    </Group>
  );
}
