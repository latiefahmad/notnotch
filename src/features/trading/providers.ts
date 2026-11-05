import type { SecretName } from "../../platform/services";

/*
 * Portfolio providers for the UI. Labels and help texts are German keys (translated with t()
 * where shown). Every help text says which read-only rights to give the key; NotNotch never
 * calls an order, transfer or withdrawal endpoint.
 *
 * Not offered: Degiro, Trade Republic, Scalable Capital (no official API).
 */

export type ProviderId = "t212" | "kraken" | "coinbase" | "binance" | "bitpanda" | "etoro" | "ibkr";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** The first field decides whether the account is set up. */
  fields: { secret: SecretName; label: string; hint?: string }[];
  help: string;
}

export const providers: ProviderInfo[] = [
  {
    id: "t212",
    name: "Trading 212",
    fields: [
      { secret: "t212.key", label: "API-Schlüssel" },
      { secret: "t212.secret", label: "API-Secret", hint: "Nur einmal sichtbar beim Erstellen" },
    ],
    help: "In Trading 212: Einstellungen → API (Beta) → Schlüssel erstellen. Rechte: Konto-Daten und Portfolio. Mehr ist nicht nötig: die Notch liest nur.",
  },
  {
    id: "kraken",
    name: "Kraken",
    fields: [
      { secret: "kraken.key", label: "API-Schlüssel" },
      { secret: "kraken.secret", label: "Privater Schlüssel" },
    ],
    help: "In Kraken: Einstellungen → API → Schlüssel erstellen. Nur „Query Funds“ und „Query Ledger Entries“ anhaken, keine Handels-, Einzahlungs- oder Auszahlungsrechte.",
  },
  {
    id: "coinbase",
    name: "Coinbase",
    fields: [
      { secret: "coinbase.key", label: "Schlüsselname", hint: "organizations/…/apiKeys/…" },
      { secret: "coinbase.secret", label: "Privater Schlüssel", hint: "Der ganze Block mit BEGIN EC PRIVATE KEY" },
    ],
    help: "Im Coinbase Developer Platform Portal einen Secret API Key mit dem Algorithmus ECDSA erstellen und nur „View“ erlauben, nicht „Trade“ oder „Transfer“.",
  },
  {
    id: "binance",
    name: "Binance",
    fields: [
      { secret: "binance.key", label: "API-Schlüssel" },
      { secret: "binance.secret", label: "Secret Key" },
    ],
    help: "In Binance: Konto → API-Verwaltung → Schlüssel erstellen. Nur „Enable Reading“ lassen, Handel, Margin und Auszahlungen aus.",
  },
  {
    id: "bitpanda",
    name: "Bitpanda",
    fields: [{ secret: "bitpanda.key", label: "API-Schlüssel" }],
    help: "In Bitpanda: Einstellungen → API-Schlüssel. Nur den Bereich „Balances“ wählen, kein „Trade (Write)“ und kein „Earn (Write)“.",
  },
  {
    id: "etoro",
    name: "eToro",
    fields: [
      { secret: "etoro.key", label: "Public API Key" },
      { secret: "etoro.user", label: "User Key" },
    ],
    help: "In eToro: Einstellungen → Trading → API Key Management. Umgebung „Real“, Berechtigung nur „Read“.",
  },
  {
    id: "ibkr",
    name: "Interactive Brokers",
    fields: [
      { secret: "ibkr.token", label: "Flex-Token" },
      { secret: "ibkr.query", label: "Flex-Query-ID" },
    ],
    help: "In Client Portal: Performance & Reports → Flex Queries. Eine Activity Flex Query mit dem Zeitraum „Last Business Day“ anlegen. Unter „Open Positions“ die Felder symbol, description, currency, assetCategory, position, markPrice, positionValue, costBasisMoney und levelOfDetail wählen, unter „Cash Report“ endingCash. Dann unter Flex Web Service einen Token erstellen. Der Stand ist der des letzten Handelstags.",
  },
];

export const providerName = (id: string): string => (id === "manual" ? "Manuell" : (providers.find((p) => p.id === id)?.name ?? id));
