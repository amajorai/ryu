import { describe, expect, it, mock } from "bun:test";
import type { LanguagePacksSnapshot } from "../shared/language-selection.ts";
import type { UiLocaleSources } from "./suggestion-locale.ts";

// The module binds Electron's `app` for production; these tests inject sources.
mock.module("electron", () => ({ app: {} }));

const { resolveUiLocale } = await import("./suggestion-locale.ts");

function sources(
	snapshot: () => Promise<LanguagePacksSnapshot>,
	system: string[] = []
): UiLocaleSources {
	return { languagePacks: snapshot, systemLanguages: () => system };
}

describe("resolveUiLocale", () => {
	it("follows a fixed built-in choice over the OS language", async () => {
		const locale = await resolveUiLocale(
			sources(
				() =>
					Promise.resolve({
						available: true,
						packs: [],
						selection: { mode: "fixed", packId: "official/ja" },
					}),
				["fr-FR"]
			)
		);
		expect(locale).toBe("ja");
	});

	it("answers English for an explicit English choice", async () => {
		const locale = await resolveUiLocale(
			sources(
				() =>
					Promise.resolve({
						available: true,
						packs: [],
						selection: { mode: "fixed", packId: null },
					}),
				["de-DE"]
			)
		);
		expect(locale).toBe("en");
	});

	it("falls back to the OS language when Core is unavailable or slow", async () => {
		const unavailable = await resolveUiLocale(
			sources(
				() => Promise.resolve({ available: false, reason: "down" }),
				["de-DE"]
			)
		);
		expect(unavailable).toBe("de-DE");
		const slow = await resolveUiLocale(
			sources(() => new Promise(() => undefined), ["ko-KR"]),
			5
		);
		expect(slow).toBe("ko-KR");
	});

	it("answers English when every source fails", async () => {
		const locale = await resolveUiLocale({
			languagePacks: () => Promise.reject(new Error("core down")),
			systemLanguages: () => {
				throw new Error("no app");
			},
		});
		expect(locale).toBe("en");
	});
});
