import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseUiLanguageSelection } from "../../../island/src/shared/language-selection.ts";
import {
	resetUiLanguagePreferenceSync,
	serializeUiLanguagePreference,
	syncUiLanguagePreference,
	UI_LANGUAGE_PREF_KEY,
	uiLanguagePreference,
} from "./ui-language-preference.ts";

const target = { token: null, url: "http://ryu.test", userJwt: null };
const originalFetch = globalThis.fetch;
let stored: string | null = null;
let puts: string[] = [];
let failPuts = false;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

beforeEach(() => {
	stored = null;
	puts = [];
	failPuts = false;
	resetUiLanguagePreferenceSync();
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname !== `/api/preferences/${UI_LANGUAGE_PREF_KEY}`) {
				return json({ error: "wrong route" }, 404);
			}
			if (init?.method === "PUT") {
				if (failPuts) {
					return json({ error: "unavailable" }, 503);
				}
				const body = JSON.parse(String(init.body)) as { value: string };
				stored = body.value;
				puts.push(body.value);
				return json({ ok: true });
			}
			return json({ key: UI_LANGUAGE_PREF_KEY, value: stored });
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("uiLanguagePreference", () => {
	it("drops the pack in auto mode and keeps an explicit English choice", () => {
		expect(uiLanguagePreference("auto", "official/es")).toEqual({
			mode: "auto",
			packId: null,
		});
		expect(uiLanguagePreference("fixed", null)).toEqual({
			mode: "fixed",
			packId: null,
		});
		expect(uiLanguagePreference("fixed", "x".repeat(129)).packId).toBeNull();
	});

	it("records a valid shown locale in auto mode only", () => {
		expect(uiLanguagePreference("auto", null, "de_DE")).toEqual({
			locale: "de-DE",
			mode: "auto",
			packId: null,
		});
		expect(uiLanguagePreference("auto", null, "not a tag")).toEqual({
			mode: "auto",
			packId: null,
		});
		expect(uiLanguagePreference("fixed", "official/ja", "ja")).toEqual({
			mode: "fixed",
			packId: "official/ja",
		});
		const raw = serializeUiLanguagePreference(
			uiLanguagePreference("auto", null, "de")
		);
		expect(JSON.parse(raw)).toEqual({
			locale: "de",
			mode: "auto",
			packId: null,
		});
		expect(parseUiLanguageSelection(raw)).toEqual({
			mode: "auto",
			packId: null,
		});
	});

	it("serializes the shape the Island parses", () => {
		const raw = serializeUiLanguagePreference(
			uiLanguagePreference("fixed", "official/es")
		);
		expect(parseUiLanguageSelection(raw)).toEqual({
			mode: "fixed",
			packId: "official/es",
		});
	});
});

describe("syncUiLanguagePreference", () => {
	it("seeds an unset key, then writes every Desktop change once", async () => {
		const spanish = uiLanguagePreference("fixed", "official/es");
		const [first, duplicate] = await Promise.all([
			syncUiLanguagePreference(target, spanish),
			syncUiLanguagePreference(target, spanish),
		]);
		expect([first, duplicate]).toEqual([true, false]);
		expect(await syncUiLanguagePreference(target, spanish)).toBe(false);

		const auto = uiLanguagePreference("auto", null);
		expect(await syncUiLanguagePreference(target, auto)).toBe(true);
		expect(puts.map(parseUiLanguageSelection)).toEqual([
			{ mode: "fixed", packId: "official/es" },
			{ mode: "auto", packId: null },
		]);
	});

	it("does not override an Island choice at launch, but a Desktop change does", async () => {
		stored = serializeUiLanguagePreference(
			uiLanguagePreference("fixed", "official/ar")
		);
		const auto = uiLanguagePreference("auto", null);
		expect(await syncUiLanguagePreference(target, auto)).toBe(false);
		// A remount with the same Desktop choice keeps the Island's choice.
		expect(await syncUiLanguagePreference(target, auto)).toBe(false);
		expect(puts).toEqual([]);

		const french = uiLanguagePreference("fixed", "official/fr");
		expect(await syncUiLanguagePreference(target, french)).toBe(true);
		expect(parseUiLanguageSelection(stored)).toEqual({
			mode: "fixed",
			packId: "official/fr",
		});
	});

	it("refreshes an auto value with the shown locale, never an Island pack", async () => {
		stored = serializeUiLanguagePreference(uiLanguagePreference("auto", null));
		const german = uiLanguagePreference("auto", null, "de");
		expect(await syncUiLanguagePreference(target, german)).toBe(true);
		expect(JSON.parse(stored ?? "null")).toEqual({
			locale: "de",
			mode: "auto",
			packId: null,
		});

		// The OS language changed while the Island had picked a pack meanwhile.
		stored = serializeUiLanguagePreference(
			uiLanguagePreference("fixed", "official/ar")
		);
		const french = uiLanguagePreference("auto", null, "fr");
		expect(await syncUiLanguagePreference(target, french)).toBe(false);
		expect(parseUiLanguageSelection(stored)).toEqual({
			mode: "fixed",
			packId: "official/ar",
		});
		expect(puts).toHaveLength(1);
	});

	it("never lets a first fixed sync replace an Island auto value", async () => {
		stored = serializeUiLanguagePreference(uiLanguagePreference("auto", null));
		const japanese = uiLanguagePreference("fixed", "official/ja");
		expect(await syncUiLanguagePreference(target, japanese)).toBe(false);
		expect(parseUiLanguageSelection(stored)).toEqual({
			mode: "auto",
			packId: null,
		});
		expect(puts).toHaveLength(0);
	});

	it("retries after a failed write", async () => {
		const spanish = uiLanguagePreference("fixed", "official/es");
		failPuts = true;
		expect(await syncUiLanguagePreference(target, spanish)).toBe(false);
		failPuts = false;
		expect(await syncUiLanguagePreference(target, spanish)).toBe(true);
		expect(puts).toHaveLength(1);
	});
});
