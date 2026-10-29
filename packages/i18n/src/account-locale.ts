// Saving the language a person picks on their account, so email uses it.
//
// The website and Desktop both call `createAccountLocaleSync`: picking a
// language writes the website's `locale` cookie at once (when the surface has
// one) and, when signed in, saves the canonical locale on the account through
// Better Auth's `update-user`. The account write is debounced and
// fire-and-forget: a failure never blocks the picker.

import { officialCatalogLocale } from "./catalog-locale.ts";
import { localeFromAcceptLanguage } from "./locale.ts";

const ACCOUNT_LOCALE_DEBOUNCE_MS = 800;
const MAX_LOCALE_LENGTH = 35;
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const ENGLISH_TAG = /^en(?:-|$)/iu;

/**
 * The locale to save on the account for one website language: `"en"` for
 * English (or no pack), the official catalog locale email renders in, or
 * null when email cannot render that language (a community voice).
 */
export function accountLocaleFor(
	locale: string | null | undefined
): string | null {
	const trimmed = (locale ?? "en").trim().replaceAll("_", "-");
	if (trimmed.length > MAX_LOCALE_LENGTH || !LOCALE_TAG.test(trimmed)) {
		return null;
	}
	if (ENGLISH_TAG.test(trimmed)) {
		return "en";
	}
	return officialCatalogLocale(localeFromAcceptLanguage(trimmed));
}

export interface AccountLocaleSyncDeps {
	delayMs?: number;
	/** Whether a person is signed in right now. */
	isSignedIn: () => Promise<boolean>;
	/** Report a failed account write (never thrown to the caller). */
	onError?: (error: unknown) => void;
	/** Save the locale on the signed-in account. */
	saveLocale: (locale: string) => Promise<{ error?: unknown } | undefined>;
	/** Write the surface's locale cookie, when it has one. */
	writeCookie?: (locale: string) => void;
}

/**
 * Build the picker's save function. The cookie is written at once; the
 * account write waits `delayMs` so quick flicks through the picker send only
 * the last choice, and skips a locale it already saved.
 */
export function createAccountLocaleSync(deps: AccountLocaleSyncDeps) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastSaved: string | null = null;
	const report = (error: unknown) => deps.onError?.(error);

	const flush = async (locale: string) => {
		if (locale === lastSaved) {
			return;
		}
		try {
			if (!(await deps.isSignedIn())) {
				return;
			}
			const result = await deps.saveLocale(locale);
			if (result?.error) {
				report(result.error);
				return;
			}
			lastSaved = locale;
		} catch (error) {
			report(error);
		}
	};

	return (websiteLocale: string | null | undefined): void => {
		const locale = accountLocaleFor(websiteLocale);
		if (!locale) {
			return;
		}
		try {
			deps.writeCookie?.(locale);
		} catch (error) {
			report(error);
		}
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			flush(locale).catch(report);
		}, deps.delayMs ?? ACCOUNT_LOCALE_DEBOUNCE_MS);
	};
}
