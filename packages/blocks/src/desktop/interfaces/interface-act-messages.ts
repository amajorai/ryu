import { activeLocale, isEnglishLocale, translate as tr } from "@ryu/i18n/lite";
import {
	type ActLineParts,
	type AskAriaParts,
	type AskKindKey,
	actClosed,
	actLowerFirst,
	askAriaParts,
	askBubbleParts,
	askKindKey,
	type BlockerAriaParts,
	blockerAriaParts,
} from "@ryuhq/protocol/interface-act-parts";
import type {
	ClockOptions,
	InterfaceAsk,
	InterfaceBlocker,
	InterfaceBlockerKind,
} from "@ryuhq/protocol/interfaces";
import { actDurationLabel, clockLabel } from "./interface-act-time.ts";

/*
 * The act layer's ask and blocker words in the UI language. These replace
 * the protocol's English `askKindWords`, `blockerKindWord`, `askBubble`,
 * `askAriaLabel` and `blockerAriaLabel` (same signatures) for everything
 * the interfaces show: each sentence is one whole catalog message built from
 * `@ryuhq/protocol/interface-act-parts`, so a translator can reorder it. In
 * English they read exactly as the protocol helpers do.
 */

/** The words that name an ask under redaction. */
export function askKindLabel(key: AskKindKey): string {
	switch (key) {
		case "suggestion":
			return tr("Suggestion");
		case "approval":
			return tr("Needs approval");
		case "question":
			return tr("Question for you");
		case "permission":
			return tr("Needs permission");
		case "input":
			return tr("Needs input");
		default:
			return tr("Reply ready");
	}
}

export function askKindWords(ask: InterfaceAsk): string {
	return askKindLabel(askKindKey(ask));
}

/** A blocker's kind in plain words (its redacted title). */
export function blockerKindWord(kind: InterfaceBlockerKind): string {
	switch (kind) {
		case "auth":
			return tr("Login needed");
		case "billing":
			return tr("Billing");
		case "interrupted":
			return tr("Interrupted");
		case "rate-limited":
			return tr("Limit hit");
		case "schedule-failed":
			return tr("Routine failed");
		default:
			return tr("Failed");
	}
}

/** A tool label's verb line: "Running bun test", "Editing snapshot.ts". */
function toolLine(verb: string, target: string): string {
	switch (verb) {
		case "Bash":
			return tr("Running {target}", { target });
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return tr("Editing {target}", { target });
		case "Glob":
			return tr("Finding {target}", { target });
		case "Grep":
		case "WebSearch":
			return tr("Searching {target}", { target });
		case "Read":
			return tr("Reading {target}", { target });
		case "Task":
			return tr("Delegating {target}", { target });
		case "TodoWrite":
			return tr("Planning {target}", { target });
		case "WebFetch":
			return tr("Fetching {target}", { target });
		default:
			return tr("Writing {target}", { target });
	}
}

/** One bubble line from its parts. */
export function actLine(parts: ActLineParts): string {
	switch (parts.kind) {
		case "kind-words":
			return askKindLabel(parts.key);
		case "run-target":
			return tr("Run {target}?", { target: parts.target });
		case "tool":
			return toolLine(parts.verb, parts.rest);
		default:
			return parts.text;
	}
}

/** Bubble words for an ask: "Run deploy.sh?", its own words, or its kind. */
export function askBubble(
	ask: InterfaceAsk,
	privacy?: "full" | "redacted"
): string {
	return actLine(askBubbleParts(ask, privacy));
}

/** The name that leads an ask sentence: the agent, else the Inbox. */
function askOwner(parts: AskAriaParts): string {
	return parts.name ?? tr("Inbox");
}

/** The ask's own words closed as a sentence, or its kind under redaction. */
export function askSentenceText(parts: AskAriaParts): string {
	return actClosed(parts.text ?? askKindLabel(parts.kind));
}

/** " Waited 14 minutes." / " Waiting about 1 day.", as sentences. */
function waitSentence(parts: AskAriaParts, past: boolean): string[] {
	if (parts.waitMs === null) {
		return [];
	}
	const duration = actDurationLabel(parts.waitMs, { long: true });
	if (past) {
		return [
			parts.waitApprox
				? tr("Waited about {duration}.", { duration })
				: tr("Waited {duration}.", { duration }),
		];
	}
	return [
		parts.waitApprox
			? tr("Waiting about {duration}.", { duration })
			: tr("Waiting {duration}.", { duration }),
	];
}

/** The listed risk tags in the UI language's list style. */
function riskList(tags: readonly string[]): string {
	const locale = activeLocale();
	if (isEnglishLocale(locale)) {
		return tags.join(", ");
	}
	return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(
		tags
	);
}

/**
 * A blocking ask's sentences after its head: target, wait, expiry, risk.
 * Shared with the act sentence of an asking agent.
 */
export function askDetailSentences(parts: AskAriaParts): string[] {
	const sentences: string[] = [];
	if (parts.target) {
		sentences.push(tr("Target: {target}", { target: actClosed(parts.target) }));
	}
	sentences.push(...waitSentence(parts, true));
	if (parts.untilMs !== null) {
		const duration = actDurationLabel(parts.untilMs, {
			long: true,
			roundUp: true,
		});
		sentences.push(
			parts.untilApprox
				? tr("Expires within {duration}.", { duration })
				: tr("Expires in {duration}.", { duration })
		);
	}
	if (parts.riskTags.length > 0) {
		sentences.push(tr("Risk: {tags}.", { tags: riskList(parts.riskTags) }));
	}
	return sentences;
}

/** `askAriaLabel` from its parts. */
export function askAriaSentence(parts: AskAriaParts): string {
	const name = askOwner(parts);
	const text = askSentenceText(parts);
	const waiting = waitSentence(parts, false);
	let head: string;
	switch (parts.variant) {
		case "reply":
			head = parts.redacted
				? tr("{name} has an answer ready.", { name })
				: tr("{name} has an answer ready: {text}", { name, text });
			return [head, ...waiting].join(" ");
		case "async-question":
			head = parts.redacted
				? tr("{name} has a question when you have time.", { name })
				: tr("{name} has a question when you have time: {text}", {
						name,
						text,
					});
			return [head, ...waiting].join(" ");
		case "suggestion":
			head = parts.redacted
				? tr("{name} has a suggestion.", { name })
				: tr("{name} suggests: {text}", { name, text });
			return [head, ...waiting].join(" ");
		default:
			head = tr("{name} asks: {text}", { name, text });
			return [head, ...askDetailSentences(parts)].join(" ");
	}
}

/** Accessible name of one ask, in the UI language (see the protocol's `askAriaLabel`). */
export function askAriaLabel(
	ask: InterfaceAsk,
	agentName: string | null,
	nowMs: number,
	privacy?: "full" | "redacted"
): string {
	return askAriaSentence(askAriaParts(ask, agentName, nowMs, privacy));
}

/** `blockerAriaLabel` from its parts. */
export function blockerAriaSentence(
	parts: BlockerAriaParts,
	nowMs: number,
	clock?: ClockOptions
): string {
	const name = parts.name;
	const kindWords = blockerKindWord(parts.kind);
	const title =
		parts.estimate && isEnglishLocale(activeLocale())
			? actLowerFirst(parts.title ?? kindWords)
			: (parts.title ?? kindWords);
	const ago =
		parts.agoMs === null ? null : actDurationLabel(parts.agoMs, { long: true });
	let head: string;
	if (parts.estimate) {
		if (ago === null) {
			head = tr("{name} stopped, likely {title}.", { name, title });
		} else if (parts.agoApprox) {
			head = tr("{name} stopped, likely {title}, about {ago} ago.", {
				ago,
				name,
				title,
			});
		} else {
			head = tr("{name} stopped, likely {title}, {ago} ago.", {
				ago,
				name,
				title,
			});
		}
	} else if (ago === null) {
		head = tr("{name} stopped: {title}.", { name, title });
	} else if (parts.agoApprox) {
		head = tr("{name} stopped: {title}, about {ago} ago.", {
			ago,
			name,
			title,
		});
	} else {
		head = tr("{name} stopped: {title}, {ago} ago.", { ago, name, title });
	}
	if (!parts.clearsAt) {
		return head;
	}
	const time = clockLabel(parts.clearsAt, nowMs, clock);
	return `${head} ${tr("Clears {time}.", { time })}`;
}

/** Accessible name of one blocker, in the UI language (see the protocol's `blockerAriaLabel`). */
export function blockerAriaLabel(
	blocker: InterfaceBlocker,
	agentName: string,
	nowMs: number,
	privacy?: "full" | "redacted",
	clock?: ClockOptions
): string {
	return blockerAriaSentence(
		blockerAriaParts(blocker, agentName, nowMs, privacy),
		nowMs,
		clock
	);
}
