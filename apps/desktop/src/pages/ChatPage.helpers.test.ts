import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { ConversationContextHandoff } from "@/src/lib/api/conversation-model-selection.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import {
	describeContextHandoff,
	formatContextWindow,
} from "./ChatPage.helpers.ts";

const PLURAL =
	"{summarizedCount} earlier {count, plural, one {message} other {messages}} summarized";
const MODEL = `${PLURAL} for {model}`;
const WINDOWS = `${PLURAL} · {from} → {to} context`;
const BOTH = `${PLURAL} for {model} · {from} → {to} context`;

// Stand-in catalogs: the real ones are generated from the extracted sources.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[PLURAL]:
			"تم تلخيص {summarizedCount} {count, plural, one {رسالة سابقة} other {رسائل سابقة}}",
		[MODEL]:
			"تم تلخيص {summarizedCount} {count, plural, one {رسالة سابقة} other {رسائل سابقة}} لـ {model}",
		[WINDOWS]:
			"تم تلخيص {summarizedCount} {count, plural, one {رسالة سابقة} other {رسائل سابقة}} · سياق {from} ← {to}",
		[BOTH]:
			"تم تلخيص {summarizedCount} {count, plural, one {رسالة سابقة} other {رسائل سابقة}} لـ {model} · سياق {from} ← {to}",
	},
	de: {
		[PLURAL]:
			"{summarizedCount} frühere {count, plural, one {Nachricht} other {Nachrichten}} zusammengefasst",
		[MODEL]:
			"{summarizedCount} frühere {count, plural, one {Nachricht} other {Nachrichten}} für {model} zusammengefasst",
		[WINDOWS]:
			"{summarizedCount} frühere {count, plural, one {Nachricht} other {Nachrichten}} zusammengefasst · Kontext {from} → {to}",
		[BOTH]:
			"{summarizedCount} frühere {count, plural, one {Nachricht} other {Nachrichten}} für {model} zusammengefasst · Kontext {from} → {to}",
	},
};

function runtimeFor(locale: string): ActiveI18nRuntime {
	return {
		direction: locale === "ar" ? "rtl" : "ltr",
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(fallback ?? id, values, locale);
		},
	};
}

function tlFor(locale: string) {
	return (source: string, values?: MessageValuesInput) =>
		formatMessage(CATALOGS[locale]?.[source] ?? source, values, locale);
}

function handoff(
	overrides: Partial<ConversationContextHandoff>
): ConversationContextHandoff {
	return {
		createdAt: 0,
		fromContext: null,
		fromModel: null,
		id: "handoff-1",
		modelChangeId: "change-1",
		reason: "context",
		summarizedCount: 12,
		summary: null,
		toContext: null,
		toModel: null,
		...overrides,
	};
}

const VARIANTS = {
	both: handoff({
		fromContext: 1_000_000,
		toContext: 128_000,
		toModel: "gpt-5",
	}),
	model: handoff({ toModel: "gpt-5" }),
	plain: handoff({}),
	windows: handoff({ fromContext: 1_000_000, toContext: 128_000 }),
};

let active: ActiveI18nRuntime | null = null;
function useLocale(locale: string) {
	active = runtimeFor(locale);
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

describe("context handoff notice", () => {
	test("English keeps the compact window readout", () => {
		expect(formatContextWindow(1_000_000)).toBe("1M");
		expect(formatContextWindow(256_000)).toBe("256K");
		expect(formatContextWindow(8192)).toBe("8K");
		expect(formatContextWindow(32_768)).toBe("33K");
		expect(formatContextWindow(1_500_000)).toBe("1.5M");
		expect(describeContextHandoff(VARIANTS.both, tlFor("en"))).toBe(
			"12 earlier messages summarized for gpt-5 · 1M → 128K context"
		);
		expect(
			describeContextHandoff(handoff({ summarizedCount: 1 }), tlFor("en"))
		).toBe("1 earlier message summarized");
	});

	test("German renders each variant as one whole sentence", () => {
		useLocale("de");
		const tl = tlFor("de");
		expect(describeContextHandoff(VARIANTS.plain, tl)).toBe(
			"12 frühere Nachrichten zusammengefasst"
		);
		expect(describeContextHandoff(VARIANTS.model, tl)).toBe(
			"12 frühere Nachrichten für gpt-5 zusammengefasst"
		);
		const windows = describeContextHandoff(VARIANTS.windows, tl);
		expect(windows).toMatch(
			// German CLDR has no short form for thousands: "128.000".
			/^12 frühere Nachrichten zusammengefasst · Kontext 1\sMio\. → 128\.000$/u
		);
		const both = describeContextHandoff(VARIANTS.both, tl);
		expect(both).toStartWith(
			"12 frühere Nachrichten für gpt-5 zusammengefasst"
		);
		for (const text of [windows, both]) {
			expect(text).not.toContain(" for ");
			expect(text).not.toContain("context");
		}
	});

	test("Arabic uses its own digits, words and mirrored arrow", () => {
		useLocale("ar");
		const tl = tlFor("ar");
		const results = Object.values(VARIANTS).map((variant) =>
			describeContextHandoff(variant, tl)
		);
		for (const text of results) {
			expect(text).toStartWith("تم تلخيص");
			expect(text).not.toContain("summarized");
			expect(text).not.toContain("→");
		}
		expect(results[1]).toContain("لـ gpt-5");
		expect(results[3]).toContain("←");
		expect(results[3]).not.toContain("128K");
	});
});
