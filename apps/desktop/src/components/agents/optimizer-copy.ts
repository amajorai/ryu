// apps/desktop/src/components/agents/optimizer-copy.ts
//
// Reader-language copy for the agent optimizer. Core stores each
// recommendation's English `title` and `summary`, but every recommendation also
// carries the typed values those sentences were built from (the change, session
// and case counts, and savings and quality as ratios). The panel renders whole
// ICU sentences from those values with the locale's plurals and percent format,
// and keeps the stored English only when a value it needs is missing.
//
// Analysis notes are plain English strings from
// `apps/core/src/server/optimizer_api.rs`. `NOTE_PATTERNS` recognizes each of
// Core's note sentences and re-renders it in the reader's language; a note it
// does not recognize is shown as Core wrote it. `optimizer-copy.test.ts` checks
// every pattern against the Rust source so the two cannot drift silently.

import { activeLocale } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { OptimizerRecommendation } from "@/src/lib/api/optimizer.ts";
import { formatLocalList, formatLocalNumber } from "@/src/lib/locale-format.ts";

function percent(ratio: number, locale: string): string {
	return formatLocalNumber(
		ratio,
		{ maximumFractionDigits: 0, style: "percent" },
		locale
	);
}

/** The recommendation's headline in the reader's language. */
export function recommendationTitle(
	rec: OptimizerRecommendation,
	tl: LiteralMessage
): string {
	const change = rec.change;
	if (change.type === "set_model") {
		return change.to
			? tl("Switch to {model}", { model: change.to })
			: rec.title;
	}
	const [first] = change.remove;
	if (first === undefined) {
		return rec.title;
	}
	return tl(
		"{count, plural, =1 {Remove the unused tool {tool}} other {Remove # unused tools}}",
		{ count: change.remove.length, tool: first }
	);
}

/** The recommendation's evidence sentence in the reader's language. */
export function recommendationSummary(
	rec: OptimizerRecommendation,
	tl: LiteralMessage,
	locale: string = activeLocale()
): string {
	const change = rec.change;
	const evidence = rec.evidence;
	if (change.type === "remove_tools") {
		if (change.remove.length === 0) {
			return rec.summary;
		}
		return tl(
			"The agent never called {tools} in its last {count, plural, one {# session} other {# sessions}}. Each allowed tool adds its description to every request, so removing unused ones cuts input tokens. This is based on usage, not a replay.",
			{
				count: evidence.sessions,
				tools: formatLocalList(change.remove, "conjunction", locale),
			}
		);
	}
	const { baselineQuality, candidateQuality, savings } = evidence;
	if (
		savings === undefined ||
		candidateQuality === undefined ||
		baselineQuality === undefined
	) {
		return rec.summary;
	}
	return tl(
		"Replaying {count, plural, one {# recent request} other {# recent requests}}, {candidate} cost {savings} less than {current} and scored {candidateQuality} against the agent's production replies (current model: {currentQuality}).",
		{
			candidate: change.to,
			candidateQuality: percent(candidateQuality, locale),
			count: evidence.cases,
			current: change.from,
			currentQuality: percent(baselineQuality, locale),
			savings: percent(savings, locale),
		}
	);
}

/**
 * One English note Core writes. `rust` is a fragment that must appear verbatim
 * in optimizer_api.rs; `match` captures the note's values in order.
 */
export interface NotePattern {
	match: RegExp;
	render: (tl: LiteralMessage, values: string[]) => string;
	rust: string;
}

function count(value: string | undefined): number | string {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : (value ?? "");
}

export const NOTE_PATTERNS: readonly NotePattern[] = [
	{
		match:
			/^The agent has (\d+) of the (\d+) sessions needed before its history is worth analyzing\.$/,
		render: (tl, [sessions, required]) =>
			tl(
				"The agent has {sessions} of the {required, plural, one {# session} other {# sessions}} needed before its history is worth analyzing.",
				{
					required: count(required),
					sessions: formatLocalNumber(Number(sessions)),
				}
			),
		rust: "sessions needed before its history is worth analyzing.",
	},
	{
		match:
			/^Tools: every allowed tool was used, or the agent may use all tools\.$/,
		render: (tl) =>
			tl("Tools: every allowed tool was used, or the agent may use all tools."),
		rust: '"Tools: every allowed tool was used, or the agent may use all tools."',
	},
	{
		match:
			/^Model: this agent runs on an external engine whose model the Gateway cannot replay\.$/,
		render: (tl) =>
			tl(
				"Model: this agent runs on an external engine whose model the Gateway cannot replay."
			),
		rust: '"Model: this agent runs on an external engine whose model the Gateway cannot replay."',
	},
	{
		match: /^Model: the agent has no chat model set to compare against\.$/,
		render: (tl) =>
			tl("Model: the agent has no chat model set to compare against."),
		rust: '"Model: the agent has no chat model set to compare against."',
	},
	{
		match:
			/^Model: only (\d+) recent turns can be replayed without tools; (\d+) are needed\.$/,
		render: (tl, [cases, required]) =>
			tl(
				"Model: only {cases, plural, one {# recent turn} other {# recent turns}} can be replayed without tools; {required} are needed.",
				{
					cases: count(cases),
					required: formatLocalNumber(Number(required)),
				}
			),
		rust: '"Model: only {} recent turns can be replayed without tools; {} are needed."',
	},
	{
		match:
			/^Model: no cheaper model with a known price is available to compare with (.+)\.$/,
		render: (tl, [model]) =>
			tl(
				"Model: no cheaper model with a known price is available to compare with {model}.",
				{ model: model ?? "" }
			),
		rust: '"Model: no cheaper model with a known price is available to compare with {current}."',
	},
	{
		match:
			/^Model: no candidate matched (.+)'s quality at a meaningfully lower cost\.$/,
		render: (tl, [model]) =>
			tl(
				"Model: no candidate matched {model}'s quality at a meaningfully lower cost.",
				{ model: model ?? "" }
			),
		rust: '"Model: no candidate matched {current}\'s quality at a meaningfully lower cost."',
	},
	{
		match: /^Model: the Gateway eval runner was unreachable \((.*)\)\.$/s,
		render: (tl, [detail]) =>
			tl("Model: the Gateway eval runner was unreachable ({detail}).", {
				detail: detail ?? "",
			}),
		rust: '"Model: the Gateway eval runner was unreachable ({error})."',
	},
	{
		match: /^Model: the Gateway eval run failed \((.*)\)\.$/s,
		render: (tl, [detail]) =>
			tl("Model: the Gateway eval run failed ({detail}).", {
				detail: detail ?? "",
			}),
		rust: '"Model: the Gateway eval run failed ({status}: {detail})."',
	},
];

/** An analysis note in the reader's language, or as Core wrote it. */
export function analysisNote(note: string, tl: LiteralMessage): string {
	for (const pattern of NOTE_PATTERNS) {
		const found = pattern.match.exec(note);
		if (found) {
			return pattern.render(tl, found.slice(1));
		}
	}
	return note;
}
