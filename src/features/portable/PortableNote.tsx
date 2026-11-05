import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { portable } from "../../platform/services";
import { Row } from "../../ui/controls";

/** Settings, Updates: says where a portable copy keeps its data, and that a read-only one uses the profile and the download page. Nothing for an installed copy. */
export function PortableNote() {
  const [info, setInfo] = useState<{ portable: boolean; writable: boolean } | null>(null);
  useEffect(() => void portable.info().then(setInfo), []);
  if (!info?.portable) return null;
  return (
    <Row
      label={t("Portable Kopie")}
      hint={
        info.writable
          ? t("Daten liegen im Ordner data neben NotNotch.exe")
          : t("Der Ordner ist schreibgeschützt: Daten liegen im Benutzerprofil, Updates öffnen die Downloadseite")
      }
    />
  );
}
