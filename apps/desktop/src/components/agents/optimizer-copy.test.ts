import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { OptimizerRecommendation } from "@/src/lib/api/optimizer.ts";
import {
	analysisNote,
	NOTE_PATTERNS,
	recommendationSummary,
	recommendationTitle,
} from "./optimizer-copy.ts";

let locale = "en";
const catalog: Record<string, string> = {};

// The real ICU formatter over a test catalog, standing in for the provider.
const tl: LiteralMessage = (source: string, values?: MessageValuesInput) =>
	formatMessage(catalog[source] ?? source, values ?? {}, locale);

afterEach(() => {
	locale = "en";
	for (const key of Object.keys(catalog)) {
		delete catalog[key];
	}
});

const modelRec: OptimizerRecommendation = {
	agentId: "agent-1",
	change: { from: "big-model", to: "small-model", type: "set_model" },
	createdAt: "2026-11-03T00:00:00Z",
	evidence: {
		baselineQuality: 0.9,
		candidateQuality: 0.88,
		cases: 8,
		savings: 0.755,
		sessions: 12,
		verified: true,
	},
	id: "opt_1",
	kind: "model",
	status: "pending",
	summary: "Replaying 8 recent requests, small-model cost 76% less ...",
	title: "Switch to small-model",
};

const toolsRec: OptimizerRecommendation = {
	agentId: "agent-1",
	change: {
		keep: ["search.web"],
		remove: ["files.read", "mail.send"],
		type: "remove_tools",
	},
	createdAt: "2026-11-03T00:00:00Z",
	evidence: { cases: 0, sessions: 11, verified: false },
	id: "opt_2",
	kind: "tools",
	status: "pending",
	summary:
		"The agent never called files.read, mail.send in its last 11 sessions.",
	title: "Remove 2 unused tools",
};

test("English titles keep Core's wording and pluralize the tool count", () => {
	expect(recommendationTitle(modelRec, tl)).toBe("Switch to small-model");
	expect(recommendationTitle(toolsRec, tl)).toBe("Remove 2 unused tools");
	const single = {
		...toolsRec,
		change: { keep: [], remove: ["mail.send"], type: "remove_tools" as const },
	};
	expect(recommendationTitle(single, tl)).toBe(
		"Remove the unused tool mail.send"
	);
});

test("the tools summary lists tools and pluralizes sessions", () => {
	expect(recommendationSummary(toolsRec, tl)).toStartWith(
		"The agent never called files.read and mail.send in its last 11 sessions."
	);
	const one = { ...toolsRec, evidence: { ...toolsRec.evidence, sessions: 1 } };
	expect(recommendationSummary(one, tl)).toContain("in its last 1 session.");
});

test("the model summary formats ratios as German percentages under de", () => {
	locale = "de";
	catalog[
		"Replaying {count, plural, one {# recent request} other {# recent requests}}, {candidate} cost {savings} less than {current} and scored {candidateQuality} against the agent's production replies (current model: {currentQuality})."
	] =
		"Bei {count, plural, one {# Anfrage} other {# Anfragen}} kostete {candidate} {savings} weniger als {current} und erreichte {candidateQuality} (aktuell: {currentQuality}).";
	expect(recommendationSummary(modelRec, tl, locale)).toBe(
		"Bei 8 Anfragen kostete small-model 76 % weniger als big-model und erreichte 88 % (aktuell: 90 %)."
	);
});

test("a persisted row missing its values falls back to the stored English", () => {
	locale = "de";
	const legacy: OptimizerRecommendation = {
		...modelRec,
		evidence: { cases: 3, sessions: 12, verified: true, savings: 0.5 },
		summary: "The replay preserved quality.",
	};
	expect(recommendationSummary(legacy, tl)).toBe(
		"The replay preserved quality."
	);
	const emptyTools = {
		...toolsRec,
		change: { keep: [], remove: [], type: "remove_tools" as const },
	};
	expect(recommendationTitle(emptyTools, tl)).toBe("Remove 2 unused tools");
	expect(recommendationSummary(emptyTools, tl)).toBe(toolsRec.summary);
});

test("Core's analysis notes are re-rendered from their values", () => {
	expect(
		analysisNote(
			"The agent has 4 of the 10 sessions needed before its history is worth analyzing.",
			tl
		)
	).toBe(
		"The agent has 4 of the 10 sessions needed before its history is worth analyzing."
	);
	expect(
		analysisNote(
			"Model: only 1 recent turns can be replayed without tools; 5 are needed.",
			tl
		)
	).toBe(
		"Model: only 1 recent turn can be replayed without tools; 5 are needed."
	);
	expect(
		analysisNote(
			"Model: no candidate matched gpt-4o's quality at a meaningfully lower cost.",
			tl
		)
	).toBe(
		"Model: no candidate matched gpt-4o's quality at a meaningfully lower cost."
	);
	expect(
		analysisNote(
			"Model: the Gateway eval run failed (502 Bad Gateway: upstream down).",
			tl
		)
	).toBe(
		"Model: the Gateway eval run failed (502 Bad Gateway: upstream down)."
	);
});

test("a translated note uses the catalog sentence", () => {
	locale = "de";
	catalog["Model: the agent has no chat model set to compare against."] =
		"Modell: Für den Agenten ist kein Chatmodell zum Vergleich eingestellt.";
	expect(
		analysisNote(
			"Model: the agent has no chat model set to compare against.",
			tl
		)
	).toBe(
		"Modell: Für den Agenten ist kein Chatmodell zum Vergleich eingestellt."
	);
});

test("an unknown note is shown as Core wrote it", () => {
	expect(analysisNote("Something new happened.", tl)).toBe(
		"Something new happened."
	);
});

test("every note pattern still matches a sentence Core writes", () => {
	const source = readFileSync(
		new URL("../../../../core/src/server/optimizer_api.rs", import.meta.url),
		"utf8"
	);
	for (const pattern of NOTE_PATTERNS) {
		expect(source).toContain(pattern.rust);
	}
});

test("only exactly one tool names it; 21 under ru stays a count", () => {
	locale = "ru";
	catalog[
		"{count, plural, =1 {Remove the unused tool {tool}} other {Remove # unused tools}}"
	] =
		"{count, plural, =1 {Удалить неиспользуемый инструмент {tool}} one {Удалить # неиспользуемый инструмент} few {Удалить # неиспользуемых инструмента} other {Удалить # неиспользуемых инструментов}}";
	const many = Array.from({ length: 21 }, (_, index) => `tool.${index}`);
	const rec = {
		...toolsRec,
		change: { keep: [], remove: many, type: "remove_tools" as const },
	};
	expect(recommendationTitle(rec, tl)).toBe(
		"Удалить 21 неиспользуемый инструмент"
	);
});

test("ja and ar render the locale's list and percent formats", () => {
	locale = "ja";
	expect(recommendationSummary(toolsRec, tl, locale)).toStartWith(
		"The agent never called files.read、mail.send in"
	);
	locale = "ar";
	catalog[
		"Replaying {count, plural, one {# recent request} other {# recent requests}}, {candidate} cost {savings} less than {current} and scored {candidateQuality} against the agent's production replies (current model: {currentQuality})."
	] = "وفّر {candidate} {savings}.";
	expect(recommendationSummary(modelRec, tl, locale)).toBe(
		`وفّر \u2068small-model\u2069 ${new Intl.NumberFormat("ar", { maximumFractionDigits: 0, style: "percent" }).format(0.755)}.`
	);
});
