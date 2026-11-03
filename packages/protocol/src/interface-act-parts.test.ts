import { describe, expect, test } from "bun:test";
import {
	type ActDuration,
	type ActLineParts,
	type AskAriaParts,
	actDayOffset,
	actDuration,
	askAriaParts,
	askBubbleParts,
	type BlockerAriaParts,
	blockerAriaParts,
} from "./interface-act-ask-parts.ts";
import {
	actClosed,
	actLowerFirst,
	agentActParts,
} from "./interface-act-parts.ts";
import {
	agentActs,
	askAriaLabel,
	askBubble,
	askKindWords,
	blockerAriaLabel,
	blockerKindWord,
	clockLabel,
	type InterfaceAsk,
	type InterfaceSnapshot,
} from "./interfaces.ts";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	usefulStateFixture,
} from "./interfaces-fixture.ts";

/*
 * The parts carry everything the English helpers word. A small English
 * renderer built only from the parts must read exactly as the helpers do,
 * so a host that renders the same parts in another language says the same.
 */

const KIND_WORDS: Record<string, string> = {
	approval: "Needs approval",
	input: "Needs input",
	permission: "Needs permission",
	question: "Question for you",
	reply: "Reply ready",
	suggestion: "Suggestion",
};

function duration(part: ActDuration | null): string {
	if (!part) {
		return "less than a minute";
	}
	return `${part.value} ${part.unit}${part.value === 1 ? "" : "s"}`;
}

function waited(ms: number | null, approx: boolean, verb: string): string[] {
	if (ms === null) {
		return [];
	}
	const about = approx ? "about " : "";
	return [`${verb} ${about}${duration(actDuration(ms, false))}.`];
}

function askSentence(parts: AskAriaParts): string {
	const who = parts.name ?? "Inbox";
	const words = parts.text ?? KIND_WORDS[parts.kind] ?? "";
	const text = actClosed(words);
	const waiting = waited(parts.waitMs, parts.waitApprox, "Waiting");
	const join = (head: string, tail: string[]) => [head, ...tail].join(" ");
	switch (parts.variant) {
		case "reply":
			return parts.redacted
				? join(`${who} has an answer ready.`, waiting)
				: join(`${who} has an answer ready: ${text}`, waiting);
		case "async-question":
			return parts.redacted
				? join(`${who} has a question when you have time.`, waiting)
				: join(`${who} has a question when you have time: ${text}`, waiting);
		case "suggestion":
			return parts.redacted
				? join(`${who} has a suggestion.`, waiting)
				: join(`${who} suggests: ${text}`, waiting);
		default: {
			const tail = [
				...(parts.target ? [`Target: ${actClosed(parts.target)}`] : []),
				...waited(parts.waitMs, parts.waitApprox, "Waited"),
				...(parts.untilMs === null
					? []
					: [
							`Expires ${parts.untilApprox ? "within" : "in"} ${duration(actDuration(parts.untilMs, true))}.`,
						]),
				...(parts.riskTags.length > 0
					? [`Risk: ${parts.riskTags.join(", ")}.`]
					: []),
			];
			return join(`${who} asks: ${text}`, tail);
		}
	}
}

function blockerSentence(parts: BlockerAriaParts): string {
	const title = parts.title ?? blockerKindWord(parts.kind);
	const head = parts.estimate
		? `${parts.name} stopped, likely ${actLowerFirst(title)}`
		: `${parts.name} stopped: ${title}`;
	const ago =
		parts.agoMs === null
			? ""
			: `, ${parts.agoApprox ? "about " : ""}${duration(actDuration(parts.agoMs, false))} ago`;
	const clears = parts.clearsAt
		? ` Clears ${clockLabel(parts.clearsAt, FIXTURE_NOW_MS, FIXTURE_CLOCK)}.`
		: "";
	return `${head}${ago}.${clears}`;
}

const VERBS: Record<string, string> = {
	Bash: "Running",
	Edit: "Editing",
	Read: "Reading",
	Write: "Writing",
};

function line(parts: ActLineParts): string {
	switch (parts.kind) {
		case "kind-words":
			return KIND_WORDS[parts.key] ?? "";
		case "run-target":
			return `Run ${parts.target}?`;
		case "tool":
			return `${VERBS[parts.verb] ?? parts.verb} ${parts.rest}`;
		default:
			return parts.text;
	}
}

function snapshots(): InterfaceSnapshot[] {
	return [
		usefulStateFixture(),
		usefulStateFixture({ livePermission: true }),
		usefulStateFixture({ privacy: "redacted" }),
	];
}

function owner(snapshot: InterfaceSnapshot, ask: InterfaceAsk): string | null {
	return (
		snapshot.agents.find((agent) => agent.id === ask.agentId)?.name ?? null
	);
}

describe("interface act parts", () => {
	test("durations count as waitLabel does", () => {
		expect(actDuration(30_000, false)).toBeNull();
		expect(actDuration(14 * 60_000, false)).toEqual({
			unit: "minute",
			value: 14,
		});
		expect(actDuration(119 * 60_000, true)).toEqual({ unit: "hour", value: 2 });
		expect(actDuration(26 * 3_600_000, false)).toEqual({
			unit: "day",
			value: 1,
		});
		expect(
			actDayOffset("2026-10-17T09:00:00Z", FIXTURE_NOW_MS, FIXTURE_CLOCK)
		).toBe(1);
	});

	test("ask parts read exactly as askAriaLabel and askBubble", () => {
		for (const snapshot of snapshots()) {
			const privacy = snapshot.privacy ?? "full";
			for (const ask of snapshot.asks ?? []) {
				const name = owner(snapshot, ask);
				const parts = askAriaParts(ask, name, FIXTURE_NOW_MS, privacy);
				expect(askSentence(parts)).toBe(
					askAriaLabel(ask, name, FIXTURE_NOW_MS, privacy)
				);
				const bubble = askBubbleParts(ask, privacy);
				const english = askBubble(ask, privacy);
				if (bubble.kind === "kind-words") {
					expect(english).toBe(askKindWords(ask));
				} else if (bubble.kind !== "tool") {
					expect(line(bubble)).toBe(english);
				}
			}
		}
	});

	test("blocker parts read exactly as blockerAriaLabel", () => {
		let seen = 0;
		for (const snapshot of snapshots()) {
			const privacy = snapshot.privacy ?? "full";
			for (const thread of snapshot.threads) {
				if (!thread.blocker) {
					continue;
				}
				seen += 1;
				const parts = blockerAriaParts(
					thread.blocker,
					"Ada",
					FIXTURE_NOW_MS,
					privacy
				);
				expect(blockerSentence(parts)).toBe(
					blockerAriaLabel(
						thread.blocker,
						"Ada",
						FIXTURE_NOW_MS,
						privacy,
						FIXTURE_CLOCK
					)
				);
			}
		}
		expect(seen).toBeGreaterThan(0);
	});

	test("act parts carry the act's own facts", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW_MS, FIXTURE_CLOCK);
		const kinds = new Set<string>();
		for (const act of acts.values()) {
			const parts = agentActParts(act, snapshot, FIXTURE_NOW_MS);
			kinds.add(parts.act);
			expect(parts.act).toBe(act.act);
			expect(parts.name).toBe(act.agentName);
			expect(act.ariaLabel.startsWith(parts.name)).toBe(true);
			expect(parts.parked.count).toBe(act.parkedAsks.length);
			expect(parts.elapsedMs === null).toBe(act.elapsed === null);
			expect(parts.stalledMs === null).toBe(act.stalledFor === null);
			expect(parts.next === null).toBe(act.next === null);
			expect(parts.bubble === null).toBe(act.bubble === null);
			if (parts.progress?.kind === "steps") {
				expect(act.ariaLabel).toContain(
					`tep ${parts.progress.done} of ${parts.progress.total}`
				);
			}
			if (parts.next?.kind === "run") {
				expect(act.next).toBe(
					`Next run ${clockLabel(parts.next.at, FIXTURE_NOW_MS, FIXTURE_CLOCK)}`
				);
			}
			if (parts.bubble?.kind === "line") {
				expect(line(parts.bubble.line)).toBe(act.bubble?.text ?? "");
			}
		}
		expect(kinds.size).toBeGreaterThan(3);
	});
});
