import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	CORE_DREAM_CHAT_SOURCE,
	CORE_DREAM_REASON_FALLBACK,
	CORE_DREAM_SUMMARY_FALLBACKS,
	dreamReason,
	dreamSource,
	dreamSummary,
} from "./memory-dream-copy.ts";

const PLURAL =
	"{count, plural, one {# proposal} other {# proposals}} waiting for your review.";

// A Japanese catalog for the three client-owned sentences; anything else
// formats in English, as tl() does for an untranslated literal.
const ja: Record<string, string> = {
	[PLURAL]: "{count} 件の提案がレビュー待ちです。",
	"Chat decomposition": "チャットの分解",
	"Derived from recent chat context; review before saving.":
		"最近のチャットの文脈から導出されました。保存する前に確認してください。",
};
const tlJa: LiteralMessage = (source, values) =>
	formatMessage(ja[source] ?? source, values ?? {});

describe("dreamSummary", () => {
	it("replaces every Core English fallback with the localized count", () => {
		for (const summary of CORE_DREAM_SUMMARY_FALLBACKS) {
			expect(dreamSummary({ proposals: [1, 2], summary }, tlJa)).toBe(
				"2 件の提案がレビュー待ちです。"
			);
		}
	});

	it("uses the localized count when Core sent no summary", () => {
		expect(dreamSummary({ proposals: [1], summary: null }, tlJa)).toBe(
			"1 件の提案がレビュー待ちです。"
		);
		expect(dreamSummary({ proposals: [1], summary: "  " }, tlJa)).toBe(
			"1 件の提案がレビュー待ちです。"
		);
	});

	it("keeps a model-written summary unchanged", () => {
		expect(
			dreamSummary(
				{ proposals: [1], summary: "旅行の好みを2件見つけました。" },
				tlJa
			)
		).toBe("旅行の好みを2件見つけました。");
	});
});

describe("dreamSource", () => {
	it("translates Core's chat source badge", () => {
		expect(dreamSource(CORE_DREAM_CHAT_SOURCE, tlJa)).toBe("チャットの分解");
	});

	it("passes other sources through and drops empty ones", () => {
		expect(dreamSource("Imported notes", tlJa)).toBe("Imported notes");
		expect(dreamSource(null, tlJa)).toBeNull();
		expect(dreamSource("", tlJa)).toBeNull();
	});
});

describe("dreamReason", () => {
	it("translates Core's fallback rationale, including persisted rows", () => {
		expect(dreamReason(CORE_DREAM_REASON_FALLBACK, tlJa)).toBe(
			"最近のチャットの文脈から導出されました。保存する前に確認してください。"
		);
	});

	it("keeps a model-written reason unchanged", () => {
		expect(dreamReason("ユーザーは毎朝コーヒーを飲む。", tlJa)).toBe(
			"ユーザーは毎朝コーヒーを飲む。"
		);
		expect(dreamReason(undefined, tlJa)).toBeNull();
	});
});

describe("Core literal coupling", () => {
	// The client matches Core's exact wording; fail here if Core rewords one.
	const core = readFileSync(
		new URL("../../../../core/src/server/memory_dream.rs", import.meta.url),
		"utf8"
	);

	it("finds every matched literal in memory_dream.rs", () => {
		for (const literal of [
			...CORE_DREAM_SUMMARY_FALLBACKS,
			CORE_DREAM_CHAT_SOURCE,
			CORE_DREAM_REASON_FALLBACK,
		]) {
			expect(core).toContain(`"${literal}"`);
		}
	});
});

describe("shipped catalogs", () => {
	// The summary plural is already translated, so Core's English fallback
	// must give way to the real de/ar catalog text (with Arabic plural forms).
	const tlFor = (locale: "ar" | "de"): LiteralMessage => {
		const catalog = JSON.parse(
			readFileSync(
				new URL(
					`../../../../../packages/i18n/locales/${locale}.json`,
					import.meta.url
				),
				"utf8"
			)
		) as Record<string, string>;
		return (source, values) =>
			formatMessage(catalog[source] ?? source, values ?? {}, locale);
	};
	const fallback = "Chat-derived suggestions waiting for your review.";

	it("renders the German pending count instead of Core's English", () => {
		expect(
			dreamSummary({ proposals: [1, 2, 3], summary: fallback }, tlFor("de"))
		).toBe("3 Vorschläge warten auf Prüfung.");
	});

	it("renders the Arabic dual form instead of Core's English", () => {
		expect(
			dreamSummary({ proposals: [1, 2], summary: fallback }, tlFor("ar"))
		).toBe("مقترحان ينتظران مراجعتك.");
	});
});
