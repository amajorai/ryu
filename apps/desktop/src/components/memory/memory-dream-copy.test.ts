import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	CORE_DREAM_ARCHIVE_REASON_FALLBACK,
	CORE_DREAM_CHAT_SOURCE,
	CORE_DREAM_REASON_FALLBACK,
	CORE_DREAM_REVIEW_CONFLICTS,
	CORE_DREAM_STALE_EVENT_REASON,
	CORE_DREAM_STALE_EVENT_REASON_LEGACY,
	CORE_DREAM_SUMMARY_FALLBACKS,
	CORE_DREAM_UNDO_MEMORY_DELETED,
	CORE_DREAM_UNDO_NOT_APPLIED,
	dreamReason,
	dreamSource,
	dreamSummary,
	reviewConflictKind,
	undoConflictKind,
} from "./memory-dream-copy.ts";

const PLURAL =
	"{count, plural, one {# proposal} other {# proposals}} waiting for your review.";

// A Japanese catalog for some client-owned sentences; anything else
// formats in English, as tl() does for an untranslated literal.
const ja: Record<string, string> = {
	[PLURAL]: "{count} 件の提案がレビュー待ちです。",
	"Chat decomposition": "チャットの分解",
	"Derived from recent chat context; review before saving.":
		"最近のチャットの文脈から導出されました。保存する前に確認してください。",
	[CORE_DREAM_STALE_EVENT_REASON]:
		"90 日以上前の出来事で、この 90 日間どのチャットにも使われていません。",
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

	it("translates Core's archive rationales", () => {
		expect(dreamReason(CORE_DREAM_STALE_EVENT_REASON, tlJa)).toBe(
			"90 日以上前の出来事で、この 90 日間どのチャットにも使われていません。"
		);
		// A proposal persisted with the earlier wording reads as the current one.
		expect(dreamReason(CORE_DREAM_STALE_EVENT_REASON_LEGACY, tlJa)).toBe(
			"90 日以上前の出来事で、この 90 日間どのチャットにも使われていません。"
		);
		// Untranslated, the archive fallback still renders through tl().
		expect(dreamReason(` ${CORE_DREAM_ARCHIVE_REASON_FALLBACK} `, tlJa)).toBe(
			CORE_DREAM_ARCHIVE_REASON_FALLBACK
		);
	});

	it("keeps a model-written reason unchanged", () => {
		expect(dreamReason("ユーザーは毎朝コーヒーを飲む。", tlJa)).toBe(
			"ユーザーは毎朝コーヒーを飲む。"
		);
		expect(dreamReason(undefined, tlJa)).toBeNull();
	});
});

describe("undoConflictKind", () => {
	it("calls a change Core no longer lists or no longer applies gone", () => {
		expect(undoConflictKind("anything", false)).toBe("gone");
		for (const message of CORE_DREAM_UNDO_NOT_APPLIED) {
			expect(undoConflictKind(message, null)).toBe("gone");
			expect(undoConflictKind(message, true)).toBe("gone");
		}
	});

	it("tells a deleted memory apart from a later change", () => {
		for (const message of CORE_DREAM_UNDO_MEMORY_DELETED) {
			expect(undoConflictKind(message, true)).toBe("deleted");
		}
		expect(
			undoConflictKind(
				"revision has itself been revised; roll back the later proposal first",
				true
			)
		).toBe("later");
		expect(undoConflictKind(undefined, null)).toBe("later");
	});
});

describe("reviewConflictKind", () => {
	it("keeps every cause Core names", () => {
		for (const code of CORE_DREAM_REVIEW_CONFLICTS) {
			expect(reviewConflictKind(code)).toBe(code);
		}
	});

	it("reads a missing or unknown code as already handled", () => {
		expect(reviewConflictKind(undefined)).toBe("handled");
		expect(reviewConflictKind("proposal is no longer pending")).toBe("handled");
	});
});

describe("Core literal coupling", () => {
	// The client matches Core's exact wording; fail here if Core rewords one.
	// Dream is split into submodules; the literals live in several of them.
	const dreamDir = new URL(
		"../../../../core/src/server/memory_dream/",
		import.meta.url
	);
	const core = readdirSync(dreamDir)
		.filter((name) => name.endsWith(".rs"))
		.map((name) => readFileSync(new URL(name, dreamDir), "utf8"))
		.join("\n");

	it("finds every matched literal in Core's Dream module", () => {
		for (const literal of [
			...CORE_DREAM_SUMMARY_FALLBACKS,
			CORE_DREAM_CHAT_SOURCE,
			CORE_DREAM_REASON_FALLBACK,
			CORE_DREAM_ARCHIVE_REASON_FALLBACK,
			CORE_DREAM_STALE_EVENT_REASON,
		]) {
			expect(core).toContain(`"${literal}"`);
		}
	});

	it("finds every review conflict code in Core", () => {
		for (const code of CORE_DREAM_REVIEW_CONFLICTS) {
			expect(core).toContain(`=> "${code}"`);
		}
	});

	it("finds every matched Undo refusal in Core", () => {
		const store = readFileSync(
			new URL(
				"../../../../../crates/core/memory/src/proposal_review.rs",
				import.meta.url
			),
			"utf8"
		);
		for (const literal of CORE_DREAM_UNDO_NOT_APPLIED) {
			expect(core).toContain(`"${literal}"`);
		}
		for (const literal of CORE_DREAM_UNDO_MEMORY_DELETED) {
			expect(store).toContain(`"${literal}"`);
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

	it("renders the stale-event reason, old wording included, in German", () => {
		const german =
			"Dieses Ereignis ist älter als 90 Tage und wurde in den letzten 90 Tagen in keinem Chat verwendet.";
		expect(dreamReason(CORE_DREAM_STALE_EVENT_REASON, tlFor("de"))).toBe(
			german
		);
		expect(dreamReason(CORE_DREAM_STALE_EVENT_REASON_LEGACY, tlFor("de"))).toBe(
			german
		);
	});

	it("renders the Arabic dual form instead of Core's English", () => {
		expect(
			dreamSummary({ proposals: [1, 2], summary: fallback }, tlFor("ar"))
		).toBe("مقترحان ينتظران مراجعتك.");
	});
});
