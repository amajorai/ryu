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

	it("retries after a failed write", async () => {
		const spanish = uiLanguagePreference("fixed", "official/es");
		failPuts = true;
		expect(await syncUiLanguagePreference(target, spanish)).toBe(false);
		failPuts = false;
		expect(await syncUiLanguagePreference(target, spanish)).toBe(true);
		expect(puts).toHaveLength(1);
	});
});
