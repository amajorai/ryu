import { expect, test } from "bun:test";
import { formatMessage, messageIdForLiteral } from "@ryu/i18n/core";
import { UNTITLED } from "@/src/contexts/chat-history/core-conversation.ts";
import AR from "../../../../packages/i18n/locales/ar.json" with {
	type: "json",
};
import DE from "../../../../packages/i18n/locales/de.json" with {
	type: "json",
};
import JA_PACK from "../../../../packages/i18n/locales/ja.json" with {
	type: "json",
};
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import { displayThreadTitle } from "./snapshot-thread-title.ts";
import { toThread } from "./snapshot-threads.ts";
import type { SnapshotTranslate } from "./snapshot-util.ts";

// A Japanese stub catalog, as in `snapshot-locale.test.ts`.
const JA: Record<string, string> = { "New chat": "新しいチャット" };
const ja: SnapshotTranslate = (source, values) =>
	formatMessage(JA[source] ?? source, values);

test("an empty title reads as the localized New chat", () => {
	expect(displayThreadTitle("", ja)).toBe("新しいチャット");
	expect(displayThreadTitle("   ", ja)).toBe("新しいチャット");
	expect(displayThreadTitle(undefined, ja)).toBe("新しいチャット");
});

test("Core's persisted English placeholder reads as the localized New chat", () => {
	expect(UNTITLED).toBe("New Chat");
	expect(displayThreadTitle(UNTITLED, ja)).toBe("新しいチャット");
});

test("a user's own title passes through verbatim", () => {
	expect(displayThreadTitle("  Trip to Kyoto ", ja)).toBe("Trip to Kyoto");
	expect(displayThreadTitle("New chat ideas", ja)).toBe("New chat ideas");
});

test("without a translator the active locale's English source is used", () => {
	expect(displayThreadTitle("")).toBe("New chat");
});

// End to end: the snapshot's thread rows follow the language the mounted
// provider shows, read through the shipped ja/ar/de packs.
const PACKS = { ar: AR, de: DE, ja: JA_PACK } as const;

function packRuntime(
	locale: keyof typeof PACKS,
	pack: Readonly<Record<string, string>>
): ActiveI18nRuntime {
	const byId = new Map(
		Object.entries(pack).map(([source, text]) => [
			messageIdForLiteral(source),
			text,
		])
	);
	return {
		direction: locale === "ar" ? "rtl" : "ltr",
		locale,
		translate: (id, _values, fallback) => byId.get(id) ?? fallback ?? id,
	};
}

for (const [locale, pack] of Object.entries(PACKS)) {
	test(`untitled snapshot threads read in ${locale}`, () => {
		const localized = pack["New chat"];
		expect(localized).toBeTruthy();
		expect(localized).not.toBe("New chat");
		const runtime = packRuntime(locale as keyof typeof PACKS, pack);
		registerActiveI18nRuntime(runtime);
		try {
			for (const title of ["", "  ", UNTITLED]) {
				const thread = toThread(
					{ createdAt: 0, id: "c-1", messages: [], title, updatedAt: 0 },
					undefined
				);
				expect(thread.title).toBe(localized ?? "");
			}
			const own = toThread(
				{ createdAt: 0, id: "c-2", messages: [], title: "Trip", updatedAt: 0 },
				undefined
			);
			expect(own.title).toBe("Trip");
		} finally {
			unregisterActiveI18nRuntime(runtime);
		}
	});
}
