// apps/desktop/src/lib/native-copy.ts
//
// Copy handed to native APIs (OS notifications, file-dialog titles and filter
// names) never reaches the DOM, so the DOM localizer cannot translate it.
// `NativeCopyLocalizer` registers the active translator here; senders call
// `localizeNativeCopy` right before the native call. Without a registered
// translator (tests, early startup) the English source passes through.

import { invokeWhenReady, whenTauriReady } from "./tauri-ready.ts";

export type NativeCopyTranslator = (text: string) => string;

let activeTranslator: NativeCopyTranslator | null = null;

/** Register the translator; returns a disposer that only clears its own. */
export function registerNativeCopyTranslator(
	translator: NativeCopyTranslator
): () => void {
	activeTranslator = translator;
	return () => {
		if (activeTranslator === translator) {
			activeTranslator = null;
		}
	};
}

/** Translate a known UI literal for a native surface; other text is unchanged. */
export function localizeNativeCopy(text: string): string;
export function localizeNativeCopy(
	text: string | null | undefined
): string | null | undefined;
export function localizeNativeCopy(
	text: string | null | undefined
): string | null | undefined {
	if (!(text && activeTranslator)) {
		return text;
	}
	try {
		return activeTranslator(text);
	} catch {
		return text;
	}
}

// ── Native shell copy (tray, quit/update confirmations, macOS app menu) ──────
//
// The Tauri process has no catalog, so the webview sends it every label already
// translated (`set_native_copy`, `src-tauri/src/native_copy.rs`). Counted
// sentences go over as one template per CLDR plural category, plus the category
// of each count below 200, so Rust picks the right form for any language.

/** Labels the shell needs, keyed by the ids `native_copy.rs` declares. */
export type NativeShellLabels = Record<string, string>;

export interface NativeShellCopy {
	/** The locale's ten digits, or null when one is not a single character. */
	digits: string | null;
	labels: NativeShellLabels;
	/**
	 * `"fixed"` when the language was chosen explicitly (macOS then keeps it
	 * as the app's `AppleLanguages`), `"auto"` when the OS language applies.
	 */
	languageMode?: "auto" | "fixed";
	/** The locale shown, so WebView2 on Windows starts in it next launch. */
	locale: string;
	/** `Intl.PluralRules` category of every count from 0 to 199. */
	pluralCategories: string[];
}

/** A `tl()`-shaped translator, so the extractor sees every source sentence. */
export type NativeShellTranslate = (
	source: string,
	values?: Record<string, number | string>
) => string;

/**
 * Resolves a named catalog id (`nativeMenu.edit`), falling back to `source`.
 * Menu titles whose platform term differs from the button verb use these.
 */
export type NativeShellTranslateId = (id: string, source: string) => string;

const PLURAL_TABLE_SIZE = 200;
const APP = { app: "{app}" };

/** Plain labels by id. `{app}` is filled with the product name natively. */
function plainLabels(
	tl: NativeShellTranslate,
	tid: NativeShellTranslateId = (_id, source) => tl(source)
): NativeShellLabels {
	return {
		"tray.show": tl("Show Ryu"),
		"tray.companion": tl("Show/Hide Companion"),
		"tray.capturePause": tl("Pause Capture"),
		"tray.captureResume": tl("Resume Capture"),
		"tray.timeline": tl("Open Timeline"),
		"tray.palette": tl("Search Everything…"),
		"tray.switchInterface": tl("Switch Interface…"),
		"tray.defaultInterface": tl("Back to Default Interface"),
		"tray.quit": tl("Quit"),
		"quit.title": tl("Quit Ryu?"),
		"quit.confirm": tl("Quit anyway"),
		"quit.cancel": tl("Keep working"),
		"update.title": tl("Install update and restart Ryu?"),
		"update.confirm": tl("Update and restart"),
		"update.cancel": tl("Keep working"),
		"update.messageIdle": tl(
			"Installing this app update restarts Ryu. Any local chats, tools, and workflows running when it restarts will stop. Finish your work first or update now. Remote nodes continue running."
		),
		"menu.about": tl("About {app}", APP),
		"menu.services": tl("Services"),
		"menu.hide": tl("Hide {app}", APP),
		"menu.hideOthers": tl("Hide Others"),
		"menu.showAll": tl("Show All"),
		"menu.quit": tl("Quit {app}", APP),
		"menu.file": tl("File"),
		"menu.closeWindow": tl("Close Window"),
		"menu.edit": tid("nativeMenu.edit", "Edit"),
		"menu.undo": tl("Undo"),
		"menu.redo": tl("Redo"),
		"menu.cut": tl("Cut"),
		"menu.copy": tl("Copy"),
		"menu.paste": tl("Paste"),
		"menu.selectAll": tl("Select All"),
		"menu.view": tl("View"),
		"menu.fullscreen": tl("Toggle Full Screen"),
		"menu.window": tl("Window"),
		"menu.minimize": tl("Minimize"),
		"menu.zoom": tid("nativeMenu.zoom", "Zoom"),
		"menu.help": tl("Help"),
	};
}

/** Counted sentences by plural base id, formatted for one `count`. */
function countedLabels(
	tl: NativeShellTranslate
): Record<string, (count: number) => string> {
	return {
		"quit.message": (count) =>
			tl(
				"{count, plural, one {# local task is still running. Quitting Ryu will stop it. Keep the app open until it finishes, or quit anyway.} other {# local tasks are still running. Quitting Ryu will stop them. Keep the app open until they finish, or quit anyway.}}",
				{ count }
			),
		"update.messageActive": (count) =>
			tl(
				"{count, plural, one {# local task is running. Installing this app update restarts Ryu and stops local chats, tools, and workflows, including work waiting for approval. Finish your work first or update now. Remote nodes continue running.} other {# local tasks are running. Installing this app update restarts Ryu and stops local chats, tools, and workflows, including work waiting for approval. Finish your work first or update now. Remote nodes continue running.}}",
				{ count }
			),
	};
}

function localeDigits(locale: string): string | null {
	try {
		const format = new Intl.NumberFormat(locale, { useGrouping: false });
		const digits = Array.from({ length: 10 }, (_, digit) =>
			format.format(digit)
		);
		return digits.every((digit) => [...digit].length === 1)
			? digits.join("")
			: null;
	} catch {
		return null;
	}
}

/**
 * One template per plural category: the sentence for the largest count of that
 * category below 200, with the count swapped for `{count}`. A form that spells
 * its number out (Arabic `two`) keeps no placeholder and is used verbatim.
 */
function pluralTemplates(
	base: string,
	format: (count: number) => string,
	categories: readonly string[],
	locale: string
): NativeShellLabels {
	const numberFormat = new Intl.NumberFormat(locale);
	const templates: NativeShellLabels = {};
	for (const category of new Set(categories)) {
		const count = categories.lastIndexOf(category);
		const text = format(count);
		const number = [numberFormat.format(count), String(count)].find((form) =>
			text.includes(form)
		);
		templates[`${base}.${category}`] =
			number === undefined ? text : text.replace(number, "{count}");
	}
	return templates;
}

/** Everything the native shell shows, in the active UI language. */
export function buildNativeShellCopy(
	tl: NativeShellTranslate,
	locale: string,
	tid?: NativeShellTranslateId
): NativeShellCopy {
	let rules: Intl.PluralRules;
	try {
		rules = new Intl.PluralRules(locale);
	} catch {
		rules = new Intl.PluralRules("en");
	}
	const pluralCategories = Array.from({ length: PLURAL_TABLE_SIZE }, (_, n) =>
		rules.select(n)
	);
	const labels = plainLabels(tl, tid);
	for (const [base, format] of Object.entries(countedLabels(tl))) {
		Object.assign(
			labels,
			pluralTemplates(base, format, pluralCategories, locale)
		);
	}
	return { digits: localeDigits(locale), labels, locale, pluralCategories };
}

/** Every label id the shell copy carries (plural ids by their base). */
export function nativeShellLabelIds(): string[] {
	const identity: NativeShellTranslate = (source) => source;
	return [
		...Object.keys(plainLabels(identity)),
		...Object.keys(countedLabels(identity)),
	];
}

/** The copy last sent (or in flight), and the newest copy requested. */
let lastSentShellCopy: string | null = null;
let latestShellCopy: string | null = null;

/**
 * Hand the shell copy to the Tauri process; a no-op outside the desktop.
 * Only the newest request is sent: a push still waiting for the bridge is
 * dropped once a later language arrives, so stale copy never lands last.
 */
export async function pushNativeShellCopy(
	copy: NativeShellCopy
): Promise<void> {
	const serialized = JSON.stringify(copy);
	latestShellCopy = serialized;
	if (serialized === lastSentShellCopy || !(await whenTauriReady())) {
		return;
	}
	if (latestShellCopy !== serialized || lastSentShellCopy === serialized) {
		return;
	}
	lastSentShellCopy = serialized;
	try {
		await invokeWhenReady("set_native_copy", { copy });
	} catch {
		// An older shell without the command keeps its English labels.
		if (lastSentShellCopy === serialized) {
			lastSentShellCopy = null;
		}
	}
}

// ── OS preferred languages (auto language mode) ──────────────────────────────
//
// WKWebView reports the bundle's development region (English) as
// `navigator.language` on a Mac set to another language, so auto mode asks
// the OS through `get_os_preferred_languages`. The last answer is cached so
// the next launch starts in the right language before the bridge answers.

const OS_LANGUAGES_CACHE_KEY = "ryu.os-preferred-languages";
const MAX_OS_LANGUAGES = 32;

function parseLanguageList(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const list = value
		.filter(
			(tag): tag is string =>
				typeof tag === "string" && tag.length > 0 && tag.length <= 35
		)
		.slice(0, MAX_OS_LANGUAGES);
	return list.length > 0 ? list : null;
}

/** The OS languages remembered from the previous launch, if any. */
export function cachedOsPreferredLanguages(): string[] | null {
	try {
		const raw = localStorage.getItem(OS_LANGUAGES_CACHE_KEY);
		return raw ? parseLanguageList(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}

/** The OS's preferred UI languages, best first; null outside the desktop. */
export async function fetchOsPreferredLanguages(): Promise<string[] | null> {
	if (!(await whenTauriReady())) {
		return null;
	}
	let list: string[] | null;
	try {
		list = parseLanguageList(
			await invokeWhenReady<unknown>("get_os_preferred_languages")
		);
	} catch {
		return null;
	}
	if (list) {
		try {
			localStorage.setItem(OS_LANGUAGES_CACHE_KEY, JSON.stringify(list));
		} catch {
			// The cache only saves a frame of English on the next launch.
		}
	}
	return list;
}
