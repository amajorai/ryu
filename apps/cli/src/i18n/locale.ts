// The CLI has no language picker of its own: like other terminal programs it
// follows the environment. RYU_LOCALE wins so a user (or a test) can pin it.

import { officialCatalogLocale } from "@ryu/i18n/catalog-locale";

/** POSIX locale names (`de_DE.UTF-8`, `pt_BR@euro`) as BCP-47 tags. */
function posixToBcp47(value: string): string {
	return value.split(/[.@]/u)[0]?.replace(/_/gu, "-") ?? "";
}

/**
 * The official locale the CLI renders in, or null for English. `C`/`POSIX`
 * and unsupported languages stay English.
 */
export function cliLocale(
	env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
	for (const name of ["RYU_LOCALE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		const raw = env[name]?.trim();
		if (!raw) {
			continue;
		}
		const tag = posixToBcp47(raw);
		if (!tag || tag === "C" || tag === "POSIX" || /^en(?:-|$)/iu.test(tag)) {
			return null;
		}
		return officialCatalogLocale(tag);
	}
	return null;
}
