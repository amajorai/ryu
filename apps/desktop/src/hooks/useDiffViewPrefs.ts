// apps/desktop/src/hooks/useDiffViewPrefs.ts
//
// localStorage-backed preferences for the workspace "Changes" diff viewer
// (`@pierre/diffs` `PatchDiff`). One JSON blob under a single key, shared across
// every consumer via an external store so the Appearance settings panel and the
// Changes tab stay in sync the instant either one changes a value — within and
// across windows. Mirrors the `usePersistedToggle` idiom (external store +
// `storage` event) but holds a whole options object instead of one boolean.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu:diff-view-prefs";

// User-facing shape. We keep this positive/plain-English (showBackground,
// wrapLines, …) and translate to `@pierre/diffs`' negative/enum options
// (disableBackground, overflow, …) at the render site, so the settings UI reads
// naturally and the mapping lives in one place.
export interface DiffViewPrefs {
	/** Change markers in the gutter. Library default: bars. */
	diffIndicators: "bars" | "classic" | "none";
	/** Side-by-side ("split") or stacked/inline ("unified"). Library default: split. */
	diffStyle: "split" | "unified";
	/** Expand unchanged context lines by default instead of collapsing them. */
	expandUnchanged: boolean;
	/** Style of the collapsed-context "…" separators between hunks. */
	hunkSeparators: "simple" | "metadata" | "line-info" | "line-info-basic";
	/** Inline (intra-line) change highlighting granularity. */
	lineDiffType: "word-alt" | "word" | "char" | "none";
	/** Full-width red/green line backgrounds. */
	showBackground: boolean;
	/** Line-number gutter. */
	showLineNumbers: boolean;
	/** Syntax-highlight theme. "system" follows the app's light/dark mode. */
	themeMode: "system" | "light" | "dark";
	/** Wrap long lines instead of horizontal scroll. */
	wrapLines: boolean;
}

// Defaults deliberately match `@pierre/diffs`' own defaults, so a user who never
// opens these settings sees exactly today's rendering.
export const DEFAULT_DIFF_VIEW_PREFS: DiffViewPrefs = {
	diffStyle: "split",
	diffIndicators: "bars",
	lineDiffType: "word",
	showBackground: true,
	showLineNumbers: true,
	wrapLines: false,
	hunkSeparators: "simple",
	expandUnchanged: false,
	themeMode: "system",
};

const listeners = new Set<() => void>();

// One cached parsed object so `getSnapshot` returns a referentially stable value
// between changes — `useSyncExternalStore` bails on the render loop otherwise.
let cache: DiffViewPrefs = DEFAULT_DIFF_VIEW_PREFS;
let cacheRaw: string | null = null;

function read(): DiffViewPrefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === cacheRaw) {
			return cache;
		}
		cacheRaw = raw;
		cache = raw
			? {
					...DEFAULT_DIFF_VIEW_PREFS,
					...(JSON.parse(raw) as Partial<DiffViewPrefs>),
				}
			: DEFAULT_DIFF_VIEW_PREFS;
	} catch {
		cache = DEFAULT_DIFF_VIEW_PREFS;
	}
	return cache;
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

function write(next: DiffViewPrefs) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Persistence is best-effort.
	}
	// Invalidate the snapshot cache so consumers in this window recompute.
	cacheRaw = null;
	for (const cb of listeners) {
		cb();
	}
}

// Don't tokenize pathologically long (usually minified/generated) lines — Shiki
// cost is superlinear in line length and a single such line can stall rendering.
const TOKENIZE_MAX_LINE_LENGTH = 2000;

/**
 * Translate the plain-English prefs into the `@pierre/diffs` `options` object.
 * One mapping, shared by the workspace Changes tab and the settings live preview,
 * so the preview always matches what the real viewer renders. `extra` lets a
 * caller layer on per-instance options (e.g. `collapsed`).
 */
export function diffViewPrefsToOptions(
	prefs: DiffViewPrefs,
	extra?: Record<string, unknown>
) {
	return {
		diffStyle: prefs.diffStyle,
		diffIndicators: prefs.diffIndicators,
		lineDiffType: prefs.lineDiffType,
		disableBackground: !prefs.showBackground,
		disableLineNumbers: !prefs.showLineNumbers,
		overflow: prefs.wrapLines ? ("wrap" as const) : ("scroll" as const),
		hunkSeparators: prefs.hunkSeparators,
		expandUnchanged: prefs.expandUnchanged,
		themeType: prefs.themeMode,
		tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
		...extra,
	};
}

/** Merge a partial patch into the stored diff-view prefs. */
export function setDiffViewPrefs(patch: Partial<DiffViewPrefs>) {
	write({ ...read(), ...patch });
}

/** Restore every diff-view pref to its default. */
export function resetDiffViewPrefs() {
	write(DEFAULT_DIFF_VIEW_PREFS);
}

/** Current diff-view prefs, re-rendering the caller whenever they change. */
export function useDiffViewPrefs(): DiffViewPrefs {
	return useSyncExternalStore(
		useCallback((cb: () => void) => subscribe(cb), []),
		read,
		() => DEFAULT_DIFF_VIEW_PREFS
	);
}
