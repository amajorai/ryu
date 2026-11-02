// The CLI has no language picker of its own: like other terminal programs it
// follows the environment. RYU_LOCALE wins so a user (or a test) can pin it,
// then the GNU `LANGUAGE` priority list, then the POSIX locale variables, and
// finally the OS locale the runtime reports (Windows shells set no `LANG`).

import { officialCatalogLocale } from "@ryu/i18n/catalog-locale";

type Env = Readonly<Record<string, string | undefined>>;

/** The CLI's languages: messages (null = English) and dates/numbers. */
export interface CliLocales {
	/** BCP-47 tag dates and numbers are formatted in. */
	format: string;
	/** Official catalog locale for copy, or null for English. */
	messages: string | null;
}

const ENGLISH: CliLocales = { format: "en", messages: null };
const POSIX_LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** POSIX locale names (`de_DE.UTF-8`, `pt_BR@euro`) as BCP-47 tags. */
function posixToBcp47(value: string): string {
	return value.split(/[.@]/u)[0]?.replace(/_/gu, "-") ?? "";
}

function isEnglish(tag: string): boolean {
	return /^en(?:-|$)/iu.test(tag);
}

function isPosixC(tag: string): boolean {
	return tag === "C" || tag === "POSIX";
}

/** A canonical BCP-47 tag, or null for `und`, POSIX variants and junk. */
function canonicalTag(tag: string): string | null {
	if (!tag || isPosixC(tag)) {
		return null;
	}
	try {
		const canonical = Intl.getCanonicalLocales(tag)[0];
		if (
			!canonical ||
			canonical === "und" ||
			canonical.startsWith("und-") ||
			/-(?:u-va-)?posix\b/iu.test(canonical)
		) {
			return null;
		}
		return canonical;
	} catch {
		return null;
	}
}

/** Resolve one locale name; C/POSIX and English mean English. */
function localesFor(raw: string): CliLocales | null {
	const tag = posixToBcp47(raw);
	if (isPosixC(tag)) {
		return ENGLISH;
	}
	const canonical = canonicalTag(tag);
	if (!canonical) {
		return null;
	}
	if (isEnglish(canonical)) {
		return { format: canonical, messages: null };
	}
	return { format: canonical, messages: officialCatalogLocale(canonical) };
}

/** The first non-empty POSIX locale variable, as GNU resolves LC_MESSAGES. */
function posixLocale(env: Env): string | null {
	for (const name of POSIX_LOCALE_VARIABLES) {
		const raw = env[name]?.trim();
		if (raw) {
			return raw;
		}
	}
	return null;
}

/**
 * GNU `LANGUAGE` (`ja:de:en`): the first entry with a catalog, or English
 * when English comes first. gettext ignores it under a bare `C`/`POSIX` locale.
 */
function languageList(env: Env, posix: string | null): CliLocales | null {
	const list = env.LANGUAGE?.trim();
	if (!list || (posix !== null && isPosixC(posix))) {
		return null;
	}
	for (const entry of list.split(":")) {
		const locales = entry.trim() ? localesFor(entry.trim()) : null;
		// A language without a catalog falls through to the next entry.
		if (locales && (locales.messages !== null || isEnglish(locales.format))) {
			return locales;
		}
	}
	return null;
}

function runtimeLocale(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		return "";
	}
}

/**
 * The locales the CLI renders in. `C`/`POSIX` and English stay English;
 * an unsupported language keeps English copy but formats dates and numbers
 * in that language, like other terminal programs.
 */
export function cliLocales(
	env: Env = process.env,
	systemLocale: string = runtimeLocale()
): CliLocales {
	const pinned = env.RYU_LOCALE?.trim();
	if (pinned) {
		const locales = localesFor(pinned);
		if (locales) {
			return locales;
		}
	}
	const posix = posixLocale(env);
	const fromLanguage = languageList(env, posix);
	if (fromLanguage) {
		return fromLanguage;
	}
	if (posix) {
		return localesFor(posix) ?? ENGLISH;
	}
	return localesFor(systemLocale) ?? ENGLISH;
}

/** The official locale the CLI renders copy in, or null for English. */
export function cliLocale(
	env: Env = process.env,
	systemLocale: string = runtimeLocale()
): string | null {
	return cliLocales(env, systemLocale).messages;
}
