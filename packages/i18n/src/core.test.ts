import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import {
	formatMessage,
	I18nRuntime,
	LanguagePackValidationError,
	languagePackArchive,
	languagePackJson,
	languagePackPortableManifest,
	MAX_LANGUAGE_PACK_BYTES,
	messageIdForLiteral,
	parseLanguagePackArchive,
	parseLanguagePackJson,
	validateLanguagePack,
} from "./core.ts";

describe("language-pack contract", () => {
	test("keeps legacy literal ids deterministic and reuses catalog ids", () => {
		const first = messageIdForLiteral("Search");
		expect(first).toBe("common.search");
		expect(messageIdForLiteral("Search")).toBe(first);
		expect(messageIdForLiteral("A legacy control")).toMatch(
			/^literal\.a-legacy-control\.[0-9a-f]{8}$/u
		);
	});

	test("formats interpolation, select, and plural messages", () => {
		expect(formatMessage("Hello, {name}!", { name: "Ari" })).toBe(
			"Hello, Ari!"
		);
		expect(
			formatMessage(
				"{count, plural, one {# file} other {# files}}",
				{ count: 2 },
				"en"
			)
		).toBe("2 files");
		expect(
			formatMessage("{mode, select, compact {Compact} other {Detailed}}", {
				mode: "compact",
			})
		).toBe("Compact");
	});

	test("rejects malformed identity and placeholder changes", () => {
		expect(() =>
			validateLanguagePack({
				baseLocale: "en",
				direction: "ltr",
				id: "../unsafe",
				locale: "en",
				messages: { "sample.greeting": "Hi" },
				name: "Unsafe",
				schemaVersion: 1,
				version: "1.0.0",
			})
		).toThrow(LanguagePackValidationError);
		expect(() =>
			validateLanguagePack({
				baseLocale: "en",
				direction: "ltr",
				id: "community/broken",
				locale: "en",
				messages: { "chat.delete-description": "Delete this?" },
				name: "Broken placeholders",
				schemaVersion: 1,
				version: "1.0.0",
			})
		).toThrow("placeholders must match the source");
	});

	test("layers a selected custom pack over the English source catalog", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "ltr",
				enabled: true,
				id: "test-pack",
				locale: "en",
				messages: { "sample.greeting": "Yo, {name}." },
				name: "Test pack",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("test-pack");
		expect(runtime.translate("sample.greeting", { name: "Ari" })).toBe(
			"Yo, Ari."
		);
		expect(runtime.translate("common.cancel")).toBe("Cancel");
	});

	test("does not apply an unselected built-in voice to the English fallback", () => {
		const runtime = new I18nRuntime();
		expect(runtime.translate("common.install")).toBe("Install");
		runtime.selectPack("en-x-ryu-online");
		expect(runtime.translate("common.install")).toBe("Yeet it in");
		expect(runtime.getSnapshot()).toMatchObject({
			locale: "en",
			packId: "en-x-ryu-online",
			packName: "English (chronically online)",
			packVersion: "1.0.0",
		});
	});

	test("keeps right-to-left packs scoped and reports their direction", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "rtl",
				id: "community/hebrew",
				locale: "he",
				messages: { "common.install": "התקנה" },
				name: "Hebrew",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("community/hebrew");
		expect(runtime.direction).toBe("rtl");
		expect(runtime.translate("common.install")).toBe("התקנה");
		expect(runtime.translate("common.cancel")).toBe("Cancel");
	});

	test("uses the caller's default message for an app-owned id", () => {
		const runtime = new I18nRuntime();
		expect(runtime.translate("my-app.refresh", {}, "Refresh this view")).toBe(
			"Refresh this view"
		);
		expect(runtime.getSnapshot()).toEqual({
			direction: "ltr",
			locale: "en",
			packId: null,
			packName: null,
			packVersion: null,
		});
	});

	test("protects app-owned placeholders with the caller's fallback", () => {
		const runtime = new I18nRuntime([
			{
				baseLocale: "en",
				direction: "ltr",
				id: "community/broken",
				locale: "en",
				messages: { "my-app.greeting": "Hi there" },
				name: "Broken placeholders",
				schemaVersion: 1,
				version: "1.0.0",
			},
		]);
		runtime.selectPack("community/broken");
		expect(
			runtime.translate("my-app.greeting", { name: "Ari" }, "Hello, {name}.")
		).toBe("Hello, Ari.");
	});

	test("supports a native persistence adapter", () => {
		const saved: (string | null)[] = [];
		const runtime = new I18nRuntime([], {
			initialPackId: null,
			persistPackId: (id) => {
				saved.push(id);
			},
		});
		runtime.selectPack("en-x-ryu-online");
		runtime.selectPack(null);
		expect(saved).toEqual(["en-x-ryu-online", null]);
	});

	test("remembers a disabled pack selection until its lifecycle is enabled", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			enabled: false,
			id: "community/later",
			locale: "en",
			messages: { "common.install": "Later" },
			name: "Later",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		const runtime = new I18nRuntime([pack]);
		runtime.selectPack(pack.id);
		expect(runtime.selectedPack).toBeNull();
		runtime.setPacks([{ ...pack, enabled: true }]);
		expect(runtime.translate("common.install")).toBe("Later");
	});

	test("enforces the portable artifact byte limit", () => {
		const messages = Object.fromEntries(
			Array.from({ length: 160 }, (_, index) => [
				`message.${index}`,
				"x".repeat(30_000),
			])
		);
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "large-pack",
			locale: "en",
			messages,
			name: "Large pack",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		let serialized: string;
		try {
			serialized = JSON.stringify(pack);
		} catch {
			throw new Error("test fixture could not be serialized");
		}
		expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
			MAX_LANGUAGE_PACK_BYTES
		);
		expect(() => parseLanguagePackJson(serialized)).toThrow(
			LanguagePackValidationError
		);
		expect(() => languagePackJson(pack)).toThrow(LanguagePackValidationError);
	});

	test("round-trips the data-only portable archive", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "community/portable",
			locale: "en",
			messages: { "common.search": "Find" },
			name: "Portable",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		expect(parseLanguagePackArchive(languagePackArchive(pack))).toEqual(pack);
	});

	test("rejects executable or unrelated archive entries", () => {
		const pack = {
			baseLocale: "en",
			direction: "ltr" as const,
			id: "community/portable",
			locale: "en",
			messages: { "common.search": "Find" },
			name: "Portable",
			schemaVersion: 1 as const,
			version: "1.0.0",
		};
		const archive = zipSync({
			"language-pack.json": strToU8(languagePackJson(pack)),
			"ryu.package.json": strToU8(
				`${JSON.stringify(languagePackPortableManifest(pack))}\n`
			),
			"payload.js": strToU8("throw new Error('must never run')"),
		});
		expect(() => parseLanguagePackArchive(archive)).toThrow(
			LanguagePackValidationError
		);
	});
});
