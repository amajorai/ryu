import { activeLocale, isEnglishLocale, translate as tr } from "@ryu/i18n/lite";
import {
	type ActBubbleParts,
	type AgentActParts,
	actClosed,
	actLowerFirst,
	agentActParts,
} from "@ryuhq/protocol/interface-act-parts";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	actLine,
	askDetailSentences,
	askKindLabel,
	askSentenceText,
	blockerAriaSentence,
	blockerKindWord,
} from "./interface-act-messages.ts";
import { actDurationLabel, clockLabel } from "./interface-act-time.ts";

/*
 * An agent's act in the UI language: its accessible sentence, bubble,
 * "next" line and elapsed words, each built from the protocol's act parts
 * with whole catalog messages. `localizeActs` swaps them into the acts the
 * protocol worded in English, so every interface that shows `act.ariaLabel`,
 * `act.bubble.text`, `act.next` or `act.elapsed` reads in the UI language.
 */

interface ActWords {
	clock: ClockOptions | undefined;
	nowMs: number;
	parts: AgentActParts;
}

function idle(name: string): string {
	return tr("{name} is idle.", { name });
}

function parkedSentences({ parked, redacted }: AgentActParts): string[] {
	if (parked.count === 0) {
		return [];
	}
	const sentences = [
		redacted || parked.first === null
			? tr("Ask waiting.")
			: tr("Ask waiting: {ask}", { ask: actClosed(parked.first) }),
	];
	if (parked.count > 1) {
		sentences.push(tr("+{count} more.", { count: parked.count - 1 }));
	}
	return sentences;
}

function askingSentence(parts: AgentActParts): string {
	const { ask, name } = parts;
	if (!ask) {
		return idle(name);
	}
	const head = parts.redacted
		? tr("{name}: {kind}.", { kind: askKindLabel(ask.kind), name })
		: tr("{name} asks: {text}", { name, text: askSentenceText(ask) });
	return [head, ...askDetailSentences(ask), ...parkedSentences(parts)].join(
		" "
	);
}

function stalledSentence(parts: AgentActParts, stalledMs: number): string {
	const duration = actDurationLabel(stalledMs, { long: true });
	const sentences = [
		tr("{name} shows no progress for {duration}; the run may have stopped.", {
			duration,
			name: parts.name,
		}),
	];
	if (parts.progress?.kind === "estimate") {
		sentences.push(tr("Progress estimated."));
	} else if (parts.progress) {
		sentences.push(
			tr("Step {done} of {total}.", {
				done: parts.progress.done,
				total: parts.progress.total,
			})
		);
	}
	return [...sentences, ...parkedSentences(parts)].join(" ");
}

function workingSentence(parts: AgentActParts): string {
	if (parts.stalledMs !== null) {
		return stalledSentence(parts, parts.stalledMs);
	}
	const values = {
		done: parts.progress?.kind === "steps" ? parts.progress.done : 0,
		elapsed:
			parts.elapsedMs === null
				? ""
				: actDurationLabel(parts.elapsedMs, { long: true }),
		longer: parts.longerThanUsual ? "yes" : "no",
		name: parts.name,
		progress: parts.progress?.kind ?? "none",
		running: parts.elapsedMs === null ? "no" : "yes",
		total: parts.progress?.kind === "steps" ? parts.progress.total : 0,
	};
	const activity = parts.working?.activity;
	const title = parts.working?.title;
	let head: string;
	if (activity) {
		head = tr(
			"{name} is {activity}{progress, select, steps {, step {done} of {total}} estimate {, progress estimated} other {}}{running, select, yes {, running {elapsed}} other {}}{longer, select, yes {, longer than usual} other {}}.",
			{
				...values,
				activity: isEnglishLocale(activeLocale())
					? actLowerFirst(activity)
					: activity,
			}
		);
	} else if (title) {
		head = tr(
			"{name} is working on {title}{progress, select, steps {, step {done} of {total}} estimate {, progress estimated} other {}}{running, select, yes {, running {elapsed}} other {}}{longer, select, yes {, longer than usual} other {}}.",
			{ ...values, title }
		);
	} else {
		head = tr(
			"{name} is working{progress, select, steps {, step {done} of {total}} estimate {, progress estimated} other {}}{running, select, yes {, running {elapsed}} other {}}{longer, select, yes {, longer than usual} other {}}.",
			values
		);
	}
	return [head, ...parkedSentences(parts)].join(" ");
}

function limitedSentence({ clock, nowMs, parts }: ActWords): string {
	const name = parts.name;
	const window = parts.limitWindow;
	if (!parts.limitBackAt) {
		return window
			? tr("{name} hit a usage limit ({window}), no reset time.", {
					name,
					window,
				})
			: tr("{name} hit a usage limit, no reset time.", { name });
	}
	const time = clockLabel(parts.limitBackAt, nowMs, clock);
	return window
		? tr("{name} hit a usage limit ({window}), back {time}.", {
				name,
				time,
				window,
			})
		: tr("{name} hit a usage limit, back {time}.", { name, time });
}

function deliveringSentence(parts: AgentActParts): string {
	const name = parts.name;
	if (parts.redacted || !parts.ask) {
		return tr("{name} has an answer ready.", { name });
	}
	const head = tr("{name} has an answer ready: {text}", {
		name,
		text: askSentenceText(parts.ask),
	});
	if (parts.filesChanged <= 0) {
		return head;
	}
	return `${head} ${tr(
		"{count, plural, one {# file changed.} other {# files changed.}}",
		{ count: parts.filesChanged }
	)}`;
}

function baseSentence(words: ActWords): string {
	const { clock, nowMs, parts } = words;
	switch (parts.act) {
		case "asking":
			return askingSentence(parts);
		case "working":
			return workingSentence(parts);
		case "blocked":
			return parts.blocker
				? blockerAriaSentence(parts.blocker, nowMs, clock)
				: idle(parts.name);
		case "limited":
			return limitedSentence(words);
		case "delivering":
			return deliveringSentence(parts);
		case "waiting":
			return tr("{name} has your message and has not started.", {
				name: parts.name,
			});
		default:
			return idle(parts.name);
	}
}

function listText(items: readonly string[]): string {
	const locale = activeLocale();
	if (isEnglishLocale(locale)) {
		return items.join(", ");
	}
	return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(
		items
	);
}

function pendingSentence(parts: AgentActParts): string | null {
	const { pending } = parts;
	const terms: string[] = [];
	if (parts.parked.count === 0 && pending.asks > 0) {
		terms.push(
			tr("{count, plural, one {# more ask} other {# more asks}}", {
				count: pending.asks,
			})
		);
	}
	if (pending.blocked > 0) {
		terms.push(
			tr("{count, plural, one {# failed thread} other {# failed threads}}", {
				count: pending.blocked,
			})
		);
	}
	if (pending.unread > 0) {
		terms.push(
			tr("{count, plural, one {# unread answer} other {# unread answers}}", {
				count: pending.unread,
			})
		);
	}
	if (pending.suggestions > 0) {
		terms.push(
			tr("{count, plural, one {# suggestion} other {# suggestions}}", {
				count: pending.suggestions,
			})
		);
	}
	if (pending.old > 0) {
		terms.push(
			tr("{count, plural, one {# older failure} other {# older failures}}", {
				count: pending.old,
			})
		);
	}
	return terms.length > 0
		? tr("Also: {items}.", { items: listText(terms) })
		: null;
}

function helpersSentence(parts: AgentActParts): string | null {
	const helpers = parts.helpers;
	if (!helpers || helpers.running <= 0) {
		return null;
	}
	return helpers.failed > 0
		? tr(
				"{count, plural, one {# helper running} other {# helpers running}}, {failed} failed.",
				{ count: helpers.running, failed: helpers.failed }
			)
		: tr("{count, plural, one {# helper running} other {# helpers running}}.", {
				count: helpers.running,
			});
}

/** "Next: write tests" / "Next run tomorrow 09:00", or null. */
export function actNextText({ clock, nowMs, parts }: ActWords): string | null {
	const next = parts.next;
	if (!next) {
		return null;
	}
	return next.kind === "step"
		? tr("Next: {step}", { step: next.step })
		: tr("Next run {time}", { time: clockLabel(next.at, nowMs, clock) });
}

/** The full accessible sentence of an act (the protocol's `ariaLabel`). */
export function actSentence(words: ActWords): string {
	const next = actNextText(words);
	return [
		baseSentence(words),
		pendingSentence(words.parts),
		helpersSentence(words.parts),
		next ? actClosed(next) : null,
	]
		.filter((sentence): sentence is string => Boolean(sentence))
		.join(" ");
}

function limitBubble(
	bubble: Extract<ActBubbleParts, { kind: "limit" }>,
	{ clock, nowMs }: ActWords
): string {
	if (!bubble.backAt) {
		return bubble.likely ? tr("Likely limit") : tr("Limit hit");
	}
	const time = clockLabel(bubble.backAt, nowMs, clock);
	return bubble.likely
		? tr("Likely limit, back {time}", { time })
		: tr("Limit hit, back {time}", { time });
}

/** The act's bubble words, or null when it shows none. */
export function actBubbleText(words: ActWords): string | null {
	const bubble = words.parts.bubble;
	if (!bubble) {
		return null;
	}
	switch (bubble.kind) {
		case "line":
			return actLine(bubble.line);
		case "blocker-kind":
			return blockerKindWord(bubble.blockerKind);
		case "files-edited":
			return tr("{count, plural, one {# file edited} other {# files edited}}", {
				count: bubble.count,
			});
		case "answer-ready":
			return tr("Answer ready");
		case "picking-up":
			return tr("Picking this up");
		case "working":
			return tr("Working");
		case "working-on":
			return tr("Working on {title}", { title: bubble.title });
		case "step":
			return tr("Step {done}/{total}: {step}", {
				done: bubble.done,
				step: bubble.step,
				total: bubble.total,
			});
		default:
			return limitBubble(bubble, words);
	}
}

/** One act with every word in the UI language. */
export function localizeAct(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	nowMs: number,
	clock?: ClockOptions
): InterfaceAgentAct {
	const words: ActWords = {
		clock,
		nowMs,
		parts: agentActParts(act, snapshot, nowMs),
	};
	const { elapsedMs, stalledMs } = words.parts;
	const text = actBubbleText(words);
	return {
		...act,
		ariaLabel: actSentence(words),
		bubble: act.bubble && text !== null ? { ...act.bubble, text } : act.bubble,
		elapsed: elapsedMs === null ? null : actDurationLabel(elapsedMs),
		next: actNextText(words),
		stalledFor:
			stalledMs === null ? null : actDurationLabel(stalledMs, { long: true }),
	};
}

/** Every act with its words in the UI language (see `localizeAct`). */
export function localizeActs(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	snapshot: InterfaceSnapshot,
	nowMs: number,
	clock?: ClockOptions
): Map<string, InterfaceAgentAct> {
	const localized = new Map<string, InterfaceAgentAct>();
	for (const [id, act] of acts) {
		localized.set(id, localizeAct(act, snapshot, nowMs, clock));
	}
	return localized;
}
