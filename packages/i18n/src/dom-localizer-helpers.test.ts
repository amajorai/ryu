import { describe, expect, test } from "bun:test";

import {
	DOM_ATTRIBUTE_SELECTOR,
	DOM_OBSERVED_ATTRIBUTES,
	isTranslatableAttribute,
	splitDocumentTitle,
} from "./dom-localizer-attributes.ts";
import {
	type CompanionI18nApi,
	createRemoteTranslator,
	REMOTE_CACHE_LIMIT,
} from "./dom-localizer-host.ts";
import type { I18nHostSnapshot } from "./runtime.ts";

function fakeElement(localName: string, type: string | null): Element {
	// SAFETY: isTranslatableAttribute reads only localName and getAttribute.
	return {
		getAttribute: (name: string) => (name === "type" ? type : null),
		localName,
	} as unknown as Element;
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("translatable attributes", () => {
	test("cover the ARIA text attributes the extractor collects", () => {
		for (const attribute of [
			"aria-placeholder",
			"aria-roledescription",
			"aria-valuetext",
		]) {
			expect(DOM_OBSERVED_ATTRIBUTES).toContain(attribute);
			expect(DOM_ATTRIBUTE_SELECTOR).toContain(`[${attribute}]`);
		}
	});

	test("treat value as copy only on button-like inputs", () => {
		expect(
			isTranslatableAttribute(fakeElement("input", "submit"), "value")
		).toBe(true);
		expect(
			isTranslatableAttribute(fakeElement("input", "RESET"), "value")
		).toBe(true);
		expect(isTranslatableAttribute(fakeElement("input", "text"), "value")).toBe(
			false
		);
		expect(isTranslatableAttribute(fakeElement("option", null), "value")).toBe(
			false
		);
		expect(isTranslatableAttribute(fakeElement("input", "text"), "title")).toBe(
			true
		);
		expect(DOM_ATTRIBUTE_SELECTOR).not.toContain(",[value]");
	});
});

describe("document titles", () => {
	test("split the page title from an NBSP-padded site suffix", () => {
		const nbsp = String.fromCodePoint(0xa0);
		const title = `Pricing ${nbsp}·${nbsp} Ryu`;
		expect(splitDocumentTitle(title)).toEqual({
			head: "Pricing ",
			tail: `${nbsp}·${nbsp} Ryu`,
		});
	});

	test("use the last separator of any supported kind", () => {
		expect(splitDocumentTitle("Docs - Getting started | Ryu")?.head).toBe(
			"Docs - Getting started"
		);
		expect(splitDocumentTitle("Settings")).toBeNull();
		expect(splitDocumentTitle(" · Ryu")).toBeNull();
	});
});

interface FakeHost extends CompanionI18nApi {
	emit(snapshot: I18nHostSnapshot): void;
	requests: string[];
}

function fakeHost(answers: Map<string, string>): FakeHost {
	let listener: ((snapshot: I18nHostSnapshot) => void) | null = null;
	const requests: string[] = [];
	return {
		emit: (snapshot) => listener?.(snapshot),
		get: () => new Promise<I18nHostSnapshot>(() => undefined),
		requests,
		subscribe: ({ onChange }) => {
			listener = onChange;
			return { dispose: () => undefined };
		},
		translate: ({ defaultMessage }) => {
			requests.push(defaultMessage);
			return Promise.resolve(answers.get(defaultMessage) ?? defaultMessage);
		},
	};
}

const GERMAN_SNAPSHOT: I18nHostSnapshot = {
	direction: "ltr",
	locale: "de",
	packId: "official/de",
	packName: "Deutsch",
	packVersion: "1.0.0",
};

describe("Companion remote translation", () => {
	test("sends untranslated text only for a non-English host locale", async () => {
		const host = fakeHost(new Map([["Ripple mode", "Ripple-Modus"]]));
		let changes = 0;
		const remote = createRemoteTranslator(host, () => {
			changes += 1;
		});
		const local = () => true;
		expect(
			remote.request("Ripple mode", "id", "Ripple mode", local)
		).toBeNull();
		host.emit({ ...GERMAN_SNAPSHOT, locale: "en", packId: null });
		expect(
			remote.request("Ripple mode", "id", "Ripple mode", local)
		).toBeNull();
		host.emit(GERMAN_SNAPSHOT);
		expect(changes).toBe(2);
		expect(
			await remote.request("Ripple mode", "id", "Ripple mode", local)
		).toBe("Ripple-Modus");
		// Text the frame already translated stays local.
		expect(remote.request("Export", "id2", "Exportieren", local)).toBeNull();
		remote.dispose();
	});

	test("cache per key and retry unchanged answers after the host publishes", async () => {
		const answers = new Map<string, string>();
		const host = fakeHost(answers);
		let changes = 0;
		const remote = createRemoteTranslator(host, () => {
			changes += 1;
		});
		host.emit(GERMAN_SNAPSHOT);
		const local = () => true;
		expect(await remote.request("Late copy", "id", "Late copy", local)).toBe(
			"Late copy"
		);
		await remote.request("Late copy", "id", "Late copy", local);
		expect(host.requests).toEqual(["Late copy"]);
		const keyBefore = remote.key();
		answers.set("Late copy", "Später Text");
		await settle();
		host.emit(GERMAN_SNAPSHOT);
		expect(changes).toBe(2);
		expect(remote.key()).not.toBe(keyBefore);
		expect(await remote.request("Late copy", "id", "Late copy", local)).toBe(
			"Später Text"
		);
		// A translated answer is final until the language changes.
		host.emit(GERMAN_SNAPSHOT);
		expect(changes).toBe(2);
		remote.dispose();
	});

	test("retry an unchanged answer once, then let the source stand", async () => {
		const host = fakeHost(new Map());
		let changes = 0;
		const remote = createRemoteTranslator(host, () => {
			changes += 1;
		});
		host.emit(GERMAN_SNAPSHOT);
		const local = () => true;
		await remote.request("3 items", "id", "3 items", local);
		host.emit(GERMAN_SNAPSHOT);
		expect(changes).toBe(2);
		await remote.request("3 items", "id", "3 items", local);
		await settle();
		// Every later publish (any runtime emit) re-sends nothing.
		host.emit(GERMAN_SNAPSHOT);
		host.emit(GERMAN_SNAPSHOT);
		await remote.request("3 items", "id", "3 items", local);
		expect(changes).toBe(2);
		expect(host.requests).toEqual(["3 items", "3 items"]);
		remote.dispose();
	});

	test("bound the answer cache, dropping the least recently used", async () => {
		const host = fakeHost(new Map());
		const remote = createRemoteTranslator(host, () => undefined);
		host.emit(GERMAN_SNAPSHOT);
		const local = () => true;
		await remote.request("first", "id", "first", local);
		for (let index = 0; index < REMOTE_CACHE_LIMIT; index += 1) {
			await remote.request(`value ${index}`, "id", `value ${index}`, local);
		}
		expect(host.requests.length).toBe(REMOTE_CACHE_LIMIT + 1);
		// The newest entries are still cached; the oldest was evicted.
		await remote.request(
			`value ${REMOTE_CACHE_LIMIT - 1}`,
			"id",
			`value ${REMOTE_CACHE_LIMIT - 1}`,
			local
		);
		expect(host.requests.length).toBe(REMOTE_CACHE_LIMIT + 1);
		await remote.request("first", "id", "first", local);
		expect(host.requests.length).toBe(REMOTE_CACHE_LIMIT + 2);
		remote.dispose();
	});

	test("defer to the host for a pack the frame does not have", async () => {
		const host = fakeHost(new Map([["Export", "Exportar (voz)"]]));
		const remote = createRemoteTranslator(host, () => undefined);
		host.emit({ ...GERMAN_SNAPSHOT, locale: "en", packId: "community/voice" });
		expect(await remote.request("Export", "id", "Export", () => false)).toBe(
			"Exportar (voz)"
		);
		remote.dispose();
	});
});
