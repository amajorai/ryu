// apps/desktop/src/hooks/useThemePreset.test.ts
//
// Guards the one invariant that made a fresh install unreadable: the theme mode
// has TWO independent resolvers, and they must agree before the user has ever
// picked a mode.
//
//   * next-themes' <ThemeProvider defaultTheme={DEFAULT_THEME_MODE}> puts the
//     `.light`/`.dark` class on <html>, which selects every `dark:` component
//     variant (switch tracks, borders, icon fills).
//   * `initTheme()` here reads the SAME `theme` localStorage key and writes the
//     active preset's colour tokens (--background/--foreground/...) inline.
//
// next-themes only writes `theme` once the user picks a mode, so on a clean
// profile the key is absent and each side falls back to its own default. When
// those defaults differed ("light" vs "system"), a dark-mode OS gave <html
// class="light"> painted with the DARK preset's tokens: dark backgrounds, light
// component variants, dark-on-dark text. It self-healed only after a manual
// toggle, because that finally wrote the key both sides read.
//
// A real DOM (localStorage + documentElement.style) is needed; register
// happy-dom before importing the module under test.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom registers a single global DOM per process; when several test files
// register it in one `bun test` run, the later calls throw "already registered".
// Guard so any file can be run alone or alongside the others.
// `isRegistered` is the registrator's OWN state, and it is the only thing
// `register()` actually checks before throwing. The previous guard tested
// `globalThis.window`, which is a different question: bun runs every file in this
// package in ONE process, so the registrator module — and its private
// `#registered` flag — is shared across files while `globalThis.window` is not a
// reliable proxy for it. The result was "Happy DOM has already been globally
// registered" thrown from whichever file happened to be evaluated second,
// failing 25 tests across 9 files that all pass individually.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_THEME_MODE, defaultThemePrefs } from "@ryu/ui/theme/prefs.ts";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	findVariant,
} from "@/src/lib/themes/presets.ts";
import { initTheme } from "./useThemePreset.ts";

const originalMatchMedia = window.matchMedia;
afterAll(() => {
	window.matchMedia = originalMatchMedia;
});

/** Use the real DOM MediaQueryList, controlling only this fixture's OS signal. */
function stubPrefersDark(prefersDark: boolean) {
	window.matchMedia = (query) => {
		const media = originalMatchMedia.call(window, query);
		Object.defineProperty(media, "matches", {
			configurable: true,
			value: query.includes("dark") ? prefersDark : false,
		});
		media.addEventListener = () => undefined;
		media.removeEventListener = () => undefined;
		media.addListener = () => undefined;
		media.removeListener = () => undefined;
		media.dispatchEvent = () => false;
		media.onchange = null;
		return media;
	};
}

function appliedBackground(): string {
	return document.documentElement.style.getPropertyValue("--background");
}

function presetBackground(id: string): string {
	const bg = findVariant(id)?.tokens["--background"];
	if (!bg) {
		throw new Error(`preset ${id} has no --background token`);
	}
	return bg;
}

beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute("style");
	stubPrefersDark(false);
});

describe("default theme mode", () => {
	test("the persisted-prefs default matches the constant both resolvers read", () => {
		expect(defaultThemePrefs().mode).toBe(DEFAULT_THEME_MODE);
	});

	test("the default follows the OS", () => {
		// Both providers are mounted with `enableSystem`, so next-themes resolves
		// the same media query these resolvers do. A concrete default here is what
		// made a dark-OS machine open in light mode until the user toggled it.
		expect(DEFAULT_THEME_MODE).toBe("system");
	});
});

describe("initTheme", () => {
	test("a fresh install on a dark OS paints the dark preset", () => {
		stubPrefersDark(true);
		expect(localStorage.getItem("theme")).toBeNull();

		initTheme();

		expect(appliedBackground()).toBe(presetBackground(DEFAULT_DARK_ID));
		expect(appliedBackground()).not.toBe(presetBackground(DEFAULT_LIGHT_ID));
	});

	test("a fresh install on a light OS paints the light preset", () => {
		// The invariant the whole file guards: <html class> and the inline tokens
		// must resolve the SAME mode before the user has picked one.
		stubPrefersDark(false);
		expect(localStorage.getItem("theme")).toBeNull();

		initTheme();

		expect(appliedBackground()).toBe(presetBackground(DEFAULT_LIGHT_ID));
	});

	test("an explicit dark choice still paints the dark preset", () => {
		localStorage.setItem("theme", "dark");
		stubPrefersDark(false);

		initTheme();

		expect(appliedBackground()).toBe(presetBackground(DEFAULT_DARK_ID));
	});

	test('"system" is still honoured once the user selects it', () => {
		localStorage.setItem("theme", "system");
		stubPrefersDark(true);

		initTheme();

		expect(appliedBackground()).toBe(presetBackground(DEFAULT_DARK_ID));
	});

	test("an unrecognised stored mode falls back to the default", () => {
		// Garbage in the key must resolve exactly like a fresh install — i.e. the
		// OS — never to a hardcoded mode the class on <html> would disagree with.
		localStorage.setItem("theme", "sepia");
		stubPrefersDark(true);

		initTheme();

		expect(appliedBackground()).toBe(presetBackground(DEFAULT_DARK_ID));
	});
});
