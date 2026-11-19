// Section headers in the sidebar and the Settings nav render in capitals
// ("AGENTS", "ACCOUNT"). The title is translated first and then capitalized in
// the reader's locale, since a capitalized English word never matches a key.

import { CLI_LOCALE, tr } from "../i18n/translate.ts";

/** A section title ("Agents") as its capitalized header ("AGENTS", "AGENTEN"). */
export function sectionHeading(title: string): string {
	return tr(title).toLocaleUpperCase(CLI_LOCALE);
}

/** The sidebar's Projects group header. */
export const projectsHeading = (): string =>
	tr("Projects").toLocaleUpperCase(CLI_LOCALE);
