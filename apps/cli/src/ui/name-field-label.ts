// The "name" row label in the agent and workflow detail panes. A bare "name"
// is on the extractor's ignore list (it is usually an identifier), so the
// row is translated through the catalogued "Name" and keeps the panes'
// lowercase field style in English.

import { CLI_LOCALE, tr } from "../i18n/translate.ts";

/** "name" in English, the catalog's "Name" in every other language. */
export function nameFieldLabel(): string {
	return CLI_LOCALE === "en" ? "name" : tr("Name");
}
