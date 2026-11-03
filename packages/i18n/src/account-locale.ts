// Saving the language a person picks on their account, so email uses it.
//
// The website and Desktop both call `createAccountLocaleSync`: picking a
// language writes the website's `locale` cookie at once (when the surface has
// one) and, when signed in, saves the canonical locale on the account through
// Better Auth's `update-user`. The account write is debounced and
// fire-and-forget: a failure never blocks the picker. A choice made while
// signed out is kept as pending and saved by `flushPending()`, which each
// surface calls when the signed-in user changes.

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

/** The picker's save function, plus the retry a surface runs on sign-in. */
export type AccountLocaleSave = ((
	websiteLocale: string | null | undefined
) => void) & {
	/**
	 * Save the last choice made while signed out. Call it when the signed-in
	 * user changes; it does nothing when no choice is pending.
	 */
	flushPending: () => Promise<void>;
};

/**
 * Build the picker's save function. The cookie is written at once; the
 * account write waits `delayMs` so quick flicks through the picker send only
 * the last choice, and skips a locale it already saved. A choice made while
 * signed out stays pending until `flushPending()` finds a signed-in account.
 */
export function createAccountLocaleSync(
	deps: AccountLocaleSyncDeps
): AccountLocaleSave {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastSaved: string | null = null;
	let pending: string | null = null;
	const report = (error: unknown) => deps.onError?.(error);

	const flush = async (locale: string) => {
		try {
			if (!(await deps.isSignedIn())) {
				// The next account may hold another language: forget the last save.
				lastSaved = null;
				pending = locale;
				return;
			}
			if (locale !== lastSaved) {
				const result = await deps.saveLocale(locale);
				if (result?.error) {
					report(result.error);
					return;
				}
				lastSaved = locale;
			}
			// Any pending choice is this one or older than it.
			pending = null;
		} catch (error) {
			report(error);
		}
	};
	// The latest account write, so a sign-in retry waits for it.
	let running: Promise<void> | null = null;
	let flushing: Promise<void> | null = null;
	const track = (locale: string): Promise<void> => {
		const write = flush(locale).finally(() => {
			if (running === write) {
				running = null;
			}
		});
		running = write;
		return write;
	};

	const save = (websiteLocale: string | null | undefined): void => {
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
			track(locale).catch(report);
		}, deps.delayMs ?? ACCOUNT_LOCALE_DEBOUNCE_MS);
	};

	const flushPending = (): Promise<void> => {
		// One retry at a time: a remount or a quick account switch shares it.
		flushing ??= (async () => {
			// A sign-out check still in flight may yet mark its choice pending.
			await running;
			// A debounced choice is newer than the pending one and flushes itself.
			if (pending && !timer) {
				await track(pending);
			}
		})().finally(() => {
			flushing = null;
		});
		return flushing;
	};

	return Object.assign(save, { flushPending });
}
