import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import {
	EN_SENSE_MESSAGES,
	OFFICIAL_SENSE_MESSAGES,
} from "./en-messages-senses.ts";
import {
	EN_SENSE_MESSAGES_MORE,
	OFFICIAL_SENSE_MESSAGES_MORE,
} from "./en-messages-senses-more.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";

describe("round 37 senses", () => {
	test("merge into the sense catalog for every official locale", () => {
		for (const [id, source] of Object.entries(EN_SENSE_MESSAGES_MORE)) {
			expect(EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES]).toBe(
				source
			);
		}
		expect(Object.keys(OFFICIAL_SENSE_MESSAGES_MORE).sort()).toEqual(
			Object.keys(OFFICIAL_SENSE_MESSAGES).sort()
		);
		for (const [locale, senses] of Object.entries(
			OFFICIAL_SENSE_MESSAGES_MORE
		)) {
			for (const [id, value] of Object.entries(senses)) {
				expect({
					id,
					locale,
					value:
						OFFICIAL_SENSE_MESSAGES[locale]?.[
							id as keyof typeof EN_SENSE_MESSAGES
						],
				}).toEqual({ id, locale, value });
			}
		}
	});

	test("each sense resolves apart from the bare word's other meaning", () => {
		// The bare words: "Free" the price (ja "無料"), "Less"/"More" the
		// show-less and overflow toggles (ja "閉じる", "その他"), "Link" the
		// account verb (fr "Associer"), "Host" hosting (de "Hosten") and "Note"
		// an annotation (zh-CN "批注").
		const expected: Record<string, Record<string, string>> = {
			de: {
				"context.freeTokens": "Frei",
				"editor.hyperlink": "Hyperlink",
				"quiz.hostRole": "Moderator",
			},
			fr: { "editor.hyperlink": "Lien", "quiz.hostRole": "Présentateur" },
			ja: {
				"context.freeTokens": "空き",
				"heatmap.less": "少",
				"heatmap.more": "多",
				"quiz.hostRole": "司会",
			},
			ru: { "editor.hyperlink": "Ссылка", "heatmap.less": "Меньше" },
			"zh-CN": { "crm.activityNote": "备注", "context.freeTokens": "剩余" },
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_MORE[id as keyof typeof EN_SENSE_MESSAGES_MORE];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
		// The bare word keeps its own literal id.
		expect(messageIdForLiteral("Link").startsWith("literal.")).toBe(true);
	});

	test("round 39 senses read apart from the bare word's catalog sense", () => {
		// The bare words: "Subjects" the abuse-report parties (ja "対象"),
		// "Script" a film script (ja "台本", es "Guion") and "Clean" a
		// reconciliation result (de "Ohne Abweichungen").
		const expected: Record<string, Record<string, string>> = {
			de: {
				"clips.captionStyleClean": "Schlicht",
				"tuition.subjectsTab": "Fächer",
				"videoStudio.cleanLook": "Klar",
			},
			es: { "workflows.codeScript": "Script de código" },
			ja: {
				"clips.captionStyleClean": "シンプル",
				"tuition.subjectsTab": "科目",
				"videoStudio.cleanLook": "クリーン",
				"workflows.codeScript": "スクリプト",
			},
			"zh-CN": {
				"tuition.subjectsTab": "科目",
				"workflows.codeScript": "脚本",
			},
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_MORE[id as keyof typeof EN_SENSE_MESSAGES_MORE];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
		for (const word of ["Clean", "Script", "Subjects"]) {
			expect(messageIdForLiteral(word).startsWith("literal.")).toBe(true);
		}
	});

	test("round 40 senses read apart from the bare word's catalog sense", () => {
		// The bare words: "Guide" the verb (ja "指示", de "Anleiten", fr
		// "Guider") and "Internal" the confidentiality label (ja "社外秘").
		const expected: Record<string, Record<string, string>> = {
			de: { "kb.guideKind": "Anleitung", "projects.internalClient": "Intern" },
			fr: { "kb.guideKind": "Guide pratique" },
			ja: { "kb.guideKind": "ガイド", "projects.internalClient": "社内" },
			ko: { "projects.internalClient": "사내" },
			"zh-CN": { "kb.guideKind": "指南", "projects.internalClient": "内部" },
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_MORE[id as keyof typeof EN_SENSE_MESSAGES_MORE];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
		for (const word of ["Guide", "Internal"]) {
			expect(messageIdForLiteral(word).startsWith("literal.")).toBe(true);
		}
	});

	test("round 41 senses read apart from the bare word's catalog sense", () => {
		// The bare words: "Availability" a product's status (ja "提供状況"),
		// "Handle" a username (de "Benutzername") and "Highlights" the
		// best-moments panel (fr "Temps forts", ru "Лучшие моменты").
		const expected: Record<string, Record<string, string>> = {
			de: {
				"flow.connectionHandle": "Verbindungspunkt",
				"videoStudio.toneHighlights": "Lichter",
			},
			fr: {
				"flow.connectionHandle": "Point de connexion",
				"videoStudio.toneHighlights": "Hautes lumières",
			},
			ja: { "computeShare.availabilityWindow": "提供可能時間" },
			ru: { "videoStudio.toneHighlights": "Света" },
			"zh-CN": {
				"computeShare.availabilityWindow": "可用时间",
				"flow.connectionHandle": "连接点",
				"videoStudio.toneHighlights": "高光",
			},
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source =
					EN_SENSE_MESSAGES_MORE[id as keyof typeof EN_SENSE_MESSAGES_MORE];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
		for (const word of ["Availability", "Handle", "Highlights"]) {
			expect(messageIdForLiteral(word).startsWith("literal.")).toBe(true);
		}
	});
});
