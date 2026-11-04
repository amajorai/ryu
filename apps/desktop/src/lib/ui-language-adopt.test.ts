import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { LANGUAGE_PACK_STORAGE_KEY } from "@ryu/i18n/core";
import {
	adoptableUiLanguage,
	adoptionStillCurrent,
	fixedPackLoading,
	readAdoptableUiLanguage,
} from "./ui-language-adopt.ts";
import {
	beginUiLanguageAdoption,
	resetUiLanguagePreferenceSync,
	serializeUiLanguagePreference,
	syncUiLanguagePreference,
	UI_LANGUAGE_PREF_KEY,
	uiLanguagePreference,
} from "./ui-language-preference.ts";

const target = { token: null, url: "http://ryu.adopt.test", userJwt: null };
const originalFetch = globalThis.fetch;
let stored: string | null = null;
let puts: string[] = [];
let failGets = false;
/** Runs once when the next GET arrives, before it answers. */
let duringNextGet: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

const fixed = (packId: string | null) =>
	serializeUiLanguagePreference(uiLanguagePreference("fixed", packId));
const auto = uiLanguagePreference("auto", null, "en-US");

beforeEach(() => {
	stored = null;
	puts = [];
	failGets = false;
	duringNextGet = null;
	resetUiLanguagePreferenceSync();
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname !== `/api/preferences/${UI_LANGUAGE_PREF_KEY}`) {
				return json({ error: "wrong route" }, 404);
			}
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)) as { value: string };
				stored = body.value;
				puts.push(body.value);
				return json({ ok: true });
			}
			const hook = duringNextGet;
			duringNextGet = null;
			hook?.();
			if (failGets) {
				return json({ error: "unavailable" }, 503);
			}
			return json({ key: UI_LANGUAGE_PREF_KEY, value: stored });
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	storage.clear();
});

// A minimal Web Storage for the saved pack id, installed only for this file.
const storage = new Map<string, string>();
const nativeStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
beforeAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			removeItem: (key: string) => storage.delete(key),
			setItem: (key: string, value: string) => storage.set(key, value),
		},
	});
});
afterAll(() => {
	if (nativeStorage) {
		Object.defineProperty(globalThis, "localStorage", nativeStorage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

describe("adoptableUiLanguage", () => {
	it("adopts a fixed choice Desktop neither wrote nor shows, including English", () => {
		const current = uiLanguagePreference("auto", null, "en");
		expect(adoptableUiLanguage(fixed("official/ar"), current, undefined)).toBe(
			"official/ar"
		);
		expect(adoptableUiLanguage(fixed(null), current, undefined)).toBeNull();
	});

	it("keeps Desktop's choice for its own value, a shown choice, auto and junk", () => {
		const current = uiLanguagePreference("fixed", "official/fr");
		expect(
			adoptableUiLanguage(fixed("official/ar"), current, fixed("official/ar"))
		).toBeUndefined();
		expect(
			adoptableUiLanguage(fixed("official/fr"), current, undefined)
		).toBeUndefined();
		expect(
			adoptableUiLanguage(
				serializeUiLanguagePreference(auto),
				current,
				undefined
			)
		).toBeUndefined();
		for (const raw of [null, "", "{", '{"mode":"fixed","packId":""}']) {
			expect(adoptableUiLanguage(raw, current, undefined)).toBeUndefined();
		}
		expect(
			adoptableUiLanguage(
				JSON.stringify({ mode: "fixed", packId: "x".repeat(129) }),
				current,
				undefined
			)
		).toBeUndefined();
	});
});

describe("readAdoptableUiLanguage", () => {
	it("returns an Island choice after Desktop's launch seed settles", async () => {
		stored = fixed("official/ar");
		const seeding = syncUiLanguagePreference(target, auto);
		const adopted = await readAdoptableUiLanguage(target, () => auto);
		expect(await seeding).toBe(false);
		expect(adopted).toEqual({
			basis: serializeUiLanguagePreference(auto),
			packId: "official/ar",
		});
		expect(adopted && adoptionStillCurrent(target, adopted)).toBe(true);
		expect(puts).toEqual([]);
	});

	it("drops a read that a newer Desktop choice overtook", async () => {
		await syncUiLanguagePreference(target, auto);
		stored = fixed("official/ar");
		const adopted = await readAdoptableUiLanguage(target, () => auto);
		expect(adopted?.packId).toBe("official/ar");
		// Desktop then picks French, which is the last writer.
		await syncUiLanguagePreference(
			target,
			uiLanguagePreference("fixed", "official/fr")
		);
		expect(adopted && adoptionStillCurrent(target, adopted)).toBe(false);
	});

	it("retries when a Desktop sync starts during the read, and adopts nothing on failure", async () => {
		await syncUiLanguagePreference(target, auto);
		stored = fixed("official/ar");
		const french = uiLanguagePreference("fixed", "official/fr");
		duringNextGet = () => {
			void syncUiLanguagePreference(target, french);
		};
		// The French write lands, so the retried read sees Desktop's own value.
		expect(await readAdoptableUiLanguage(target, () => french)).toBeNull();
		expect(stored).toBe(fixed("official/fr"));
		failGets = true;
		stored = fixed("official/ar");
		expect(await readAdoptableUiLanguage(target, () => french)).toBeNull();
	});
});

describe("adoption hold", () => {
	it("holds syncs of the previous choice until Desktop shows the adopted one", async () => {
		await syncUiLanguagePreference(target, auto);
		puts = [];
		stored = fixed("official/ar");
		beginUiLanguageAdoption(
			target,
			uiLanguagePreference("fixed", "official/ar")
		);
		// A render that still shows the previous choice writes nothing.
		expect(
			await syncUiLanguagePreference(
				target,
				uiLanguagePreference("fixed", "official/fr")
			)
		).toBe(false);
		expect(
			await syncUiLanguagePreference(
				target,
				uiLanguagePreference("fixed", "official/ar")
			)
		).toBe(false);
		expect(puts).toEqual([]);
		// After that, a Desktop change writes again.
		expect(
			await syncUiLanguagePreference(
				target,
				uiLanguagePreference("fixed", "official/fr")
			)
		).toBe(true);
		expect(stored).toBe(fixed("official/fr"));
	});
});

describe("fixedPackLoading", () => {
	const packs = [{ id: "official/fr" }];
	it("is only true in fixed mode while the saved pack is missing from the catalog", () => {
		storage.set(LANGUAGE_PACK_STORAGE_KEY, "official/fr");
		expect(fixedPackLoading("fixed", null, [])).toBe(true);
		expect(fixedPackLoading("fixed", null, packs)).toBe(false);
		expect(fixedPackLoading("fixed", "official/fr", [])).toBe(false);
		expect(fixedPackLoading("auto", null, [])).toBe(false);
		storage.delete(LANGUAGE_PACK_STORAGE_KEY);
		expect(fixedPackLoading("fixed", null, [])).toBe(false);
	});
});
