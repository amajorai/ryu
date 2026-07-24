// apps/desktop/src/hooks/useDiffViewPrefs.test.ts
//
// Tests for the diff-view preference mapping + persistence. Two things carry
// real risk here: `diffViewPrefsToOptions` translates the plain-English UI
// prefs into `@pierre/diffs`' negative/enum option names (showBackground ->
// disableBackground, wrapLines -> overflow "wrap"/"scroll"), and a single sign
// flip would render every diff with the wrong background/wrapping; and the
// localStorage-backed read/write must merge partial stored blobs over defaults
// so an old blob written before a field existed never yields `undefined`.
//
// A real DOM (localStorage) is needed for the persistence half; register
// happy-dom before importing the module under test.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom registers a single global DOM per process; when several test files
// register it in one `bun test` run, the later calls throw "already registered".
// Guard so any file can be run alone or alongside the others.
if (typeof globalThis.window === "undefined") {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_DIFF_VIEW_PREFS,
	type DiffViewPrefs,
	diffViewPrefsToOptions,
	resetDiffViewPrefs,
	setDiffViewPrefs,
} from "./useDiffViewPrefs.ts";

const STORAGE_KEY = "ryu:diff-view-prefs";

beforeEach(() => {
	localStorage.clear();
});

describe("diffViewPrefsToOptions", () => {
	test("maps positive UI prefs to @pierre/diffs' negative/enum options", () => {
		const opts = diffViewPrefsToOptions(DEFAULT_DIFF_VIEW_PREFS);
		// Defaults: showBackground/showLineNumbers true → disable* false.
		expect(opts.disableBackground).toBe(false);
		expect(opts.disableLineNumbers).toBe(false);
		// wrapLines false → overflow "scroll".
		expect(opts.overflow).toBe("scroll");
		// Pass-through fields keep their value + name.
		expect(opts.diffStyle).toBe("split");
		expect(opts.diffIndicators).toBe("bars");
		expect(opts.lineDiffType).toBe("word");
		expect(opts.hunkSeparators).toBe("simple");
		expect(opts.expandUnchanged).toBe(false);
		expect(opts.themeType).toBe("system");
	});

	test("inverts the boolean toggles when the user turns them off", () => {
		const prefs: DiffViewPrefs = {
			...DEFAULT_DIFF_VIEW_PREFS,
			showBackground: false,
			showLineNumbers: false,
			wrapLines: true,
		};
		const opts = diffViewPrefsToOptions(prefs);
		expect(opts.disableBackground).toBe(true);
		expect(opts.disableLineNumbers).toBe(true);
		expect(opts.overflow).toBe("wrap");
	});

	test("always caps tokenization length to guard against pathological lines", () => {
		expect(
			diffViewPrefsToOptions(DEFAULT_DIFF_VIEW_PREFS).tokenizeMaxLineLength
		).toBe(2000);
	});

	test("layers `extra` on top, and lets it override mapped fields", () => {
		const opts = diffViewPrefsToOptions(DEFAULT_DIFF_VIEW_PREFS, {
			collapsed: true,
			overflow: "wrap",
		});
		expect(opts.collapsed).toBe(true);
		// `extra` is spread last, so it wins over the computed overflow.
		expect(opts.overflow).toBe("wrap");
	});
});

describe("persistence: setDiffViewPrefs / resetDiffViewPrefs", () => {
	test("setDiffViewPrefs merges a partial patch onto current prefs", () => {
		setDiffViewPrefs({ diffStyle: "unified" });
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}"
		) as DiffViewPrefs;
		expect(stored.diffStyle).toBe("unified");
		// Untouched fields keep their default value.
		expect(stored.showBackground).toBe(true);
	});

	test("successive patches accumulate rather than replace", () => {
		setDiffViewPrefs({ diffStyle: "unified" });
		setDiffViewPrefs({ wrapLines: true });
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}"
		) as DiffViewPrefs;
		expect(stored.diffStyle).toBe("unified");
		expect(stored.wrapLines).toBe(true);
	});

	test("a partial stored blob is read back merged over defaults (no undefined fields)", () => {
		// Simulate a blob written by an older build that lacked `themeMode`.
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ diffStyle: "unified" }));
		// setDiffViewPrefs reads current (merged) prefs, patches, and rewrites.
		setDiffViewPrefs({ wrapLines: true });
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}"
		) as DiffViewPrefs;
		expect(stored.diffStyle).toBe("unified");
		expect(stored.wrapLines).toBe(true);
		// The missing field is filled from defaults, never left undefined.
		expect(stored.themeMode).toBe("system");
	});

	test("resetDiffViewPrefs restores every field to its default", () => {
		setDiffViewPrefs({ diffStyle: "unified", wrapLines: true });
		resetDiffViewPrefs();
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}"
		) as DiffViewPrefs;
		expect(stored).toEqual(DEFAULT_DIFF_VIEW_PREFS);
	});

	test("corrupt JSON in storage falls back to defaults instead of throwing", () => {
		localStorage.setItem(STORAGE_KEY, "{not valid json");
		// read() swallows the parse error; setDiffViewPrefs patches over defaults.
		expect(() => setDiffViewPrefs({ wrapLines: true })).not.toThrow();
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}"
		) as DiffViewPrefs;
		expect(stored.wrapLines).toBe(true);
		expect(stored.diffStyle).toBe("split");
	});
});
