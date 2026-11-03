// The act layer's words follow the UI language. In English the localized
// renderers read exactly as the protocol's English helpers; under another
// language every sentence comes from the catalog, so no English sentence
// is left in bubbles, status lines or accessible names.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import {
	agentActs,
	askAriaLabel as englishAskAriaLabel,
	askBubble as englishAskBubble,
	blockerAriaLabel as englishBlockerAriaLabel,
	waitLabel as englishWaitLabel,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { actAnnouncement } from "./game3d-acts-summary.ts";
import {
	askAriaLabel,
	askBubble,
	blockerAriaLabel,
} from "./interface-act-messages.ts";
import { localizeActs } from "./interface-act-sentences.ts";
import { waitLabel } from "./interface-act-time.ts";
import { AskQueueList } from "./interface-ask-card-queue.tsx";
import { deskLabel } from "./workers-status.tsx";

/**
 * A stand-in "translation" for any message: every Latin letter of its
 * static text (even brace depth) becomes a katakana, while arguments,
 * plural and select syntax stay. Words that reach the screen without the
 * catalog stay Latin and are caught below.
 */
function pseudo(source: string): string {
	let depth = 0;
	let out = "";
	for (const char of source) {
		if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
		}
		out += depth % 2 === 0 && /[A-Za-z]/.test(char) ? "ア" : char;
	}
	return out;
}

const registered: object[] = [];
function useJapanese() {
	const runtime = {
		direction: "ltr" as const,
		locale: "ja",
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(pseudo(fallback ?? id), values, "ja");
		},
	};
	registered.push(runtime);
	registerActiveI18nRuntime(runtime);
}

afterEach(() => {
	for (const runtime of registered.splice(0)) {
		unregisterActiveI18nRuntime(runtime as never);
	}
});

const SNAPSHOTS: Record<string, InterfaceSnapshot> = {
	full: usefulStateFixture(),
	live: usefulStateFixture({ livePermission: true }),
	redacted: usefulStateFixture({ privacy: "redacted" }),
};

/** Every word the snapshot itself carries (names, titles, asks, labels). */
function contentWords(snapshot: InterfaceSnapshot): Set<string> {
	const words = new Set<string>();
	const visit = (value: unknown) => {
		if (typeof value === "string") {
			for (const word of value.split(/[^A-Za-z]+/)) {
				words.add(word);
			}
		} else if (value && typeof value === "object") {
			for (const entry of Object.values(value)) {
				visit(entry);
			}
		}
	};
	visit(snapshot);
	return words;
}

/** Runs of 3+ Latin words not taken from the snapshot's own content. */
function englishSentences(text: string, content: Set<string>): string[] {
	const kept = text
		.split(/([A-Za-z]+)/)
		.map((part) => (/^[A-Za-z]+$/.test(part) && content.has(part) ? "·" : part))
		.join("");
	return kept.match(/[A-Za-z]+(?:[\s,.:;'’-]+[A-Za-z]+){2,}/g) ?? [];
}

describe("interface act messages in English", () => {
	test("act sentences, bubbles and times read as the protocol's", () => {
		for (const snapshot of Object.values(SNAPSHOTS)) {
			const english = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
			const local = localizeActs(english, snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
			for (const [id, act] of english) {
				const mine = local.get(id);
				expect(mine?.ariaLabel).toBe(act.ariaLabel);
				expect(mine?.bubble).toEqual(act.bubble);
				expect(mine?.next).toBe(act.next);
				expect(mine?.elapsed).toBe(act.elapsed);
				expect(mine?.stalledFor).toBe(act.stalledFor);
			}
		}
	});

	test("ask and blocker names read as the protocol's", () => {
		for (const snapshot of Object.values(SNAPSHOTS)) {
			const privacy = snapshot.privacy ?? "full";
			for (const ask of snapshot.asks ?? []) {
				expect(askAriaLabel(ask, "Ada", FIXTURE_NOW, privacy)).toBe(
					englishAskAriaLabel(ask, "Ada", FIXTURE_NOW, privacy)
				);
				expect(askAriaLabel(ask, null, FIXTURE_NOW, privacy)).toBe(
					englishAskAriaLabel(ask, null, FIXTURE_NOW, privacy)
				);
				expect(askBubble(ask, privacy)).toBe(englishAskBubble(ask, privacy));
				const options = {
					approx: ask.sinceApprox,
					until: ask.expiresAt ?? null,
					untilApprox: ask.expiresApprox,
				};
				expect(waitLabel(ask.since, FIXTURE_NOW, options)).toBe(
					englishWaitLabel(ask.since, FIXTURE_NOW, options)
				);
			}
			for (const thread of snapshot.threads) {
				if (thread.blocker) {
					expect(
						blockerAriaLabel(
							thread.blocker,
							"Ada",
							FIXTURE_NOW,
							privacy,
							FIXTURE_CLOCK
						)
					).toBe(
						englishBlockerAriaLabel(
							thread.blocker,
							"Ada",
							FIXTURE_NOW,
							privacy,
							FIXTURE_CLOCK
						)
					);
				}
			}
		}
	});
});

describe("interface act messages under Japanese", () => {
	test("no English sentence is left in acts, asks or blockers", () => {
		useJapanese();
		for (const snapshot of Object.values(SNAPSHOTS)) {
			const content = contentWords(snapshot);
			const privacy = snapshot.privacy ?? "full";
			const english = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
			const local = localizeActs(english, snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
			const texts: string[] = [];
			for (const act of local.values()) {
				texts.push(act.ariaLabel, act.bubble?.text ?? "", act.next ?? "");
				texts.push(act.elapsed ?? "", act.stalledFor ?? "");
			}
			for (const ask of snapshot.asks ?? []) {
				texts.push(askAriaLabel(ask, null, FIXTURE_NOW, privacy));
				texts.push(askBubble(ask, privacy));
			}
			for (const thread of snapshot.threads) {
				if (thread.blocker) {
					texts.push(
						blockerAriaLabel(thread.blocker, "Ada", FIXTURE_NOW, privacy)
					);
				}
			}
			const leaks = texts.flatMap((text) => englishSentences(text, content));
			expect(leaks).toEqual([]);
			// The sentences really changed: the stand-in catalog was used.
			expect(
				[...local.values()].some((act) => act.ariaLabel.includes("ア"))
			).toBe(true);
		}
	});

	test("the ask queue's names and labels come from the catalog", () => {
		useJapanese();
		const snapshot = SNAPSHOTS.full as InterfaceSnapshot;
		const acts = localizeActs(
			agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK),
			snapshot,
			FIXTURE_NOW,
			FIXTURE_CLOCK
		);
		const html = renderToStaticMarkup(
			<AskQueueList
				acts={acts}
				clock={FIXTURE_CLOCK}
				mode="sheet"
				nowMs={FIXTURE_NOW}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				snapshot={snapshot}
				unowned={[]}
			/>
		);
		const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map(
			(match) => match[1] ?? ""
		);
		expect(labels.length).toBeGreaterThan(1);
		const content = contentWords(snapshot);
		expect(labels.flatMap((label) => englishSentences(label, content))).toEqual(
			[]
		);
	});

	test("an unowned ask is announced for the Inbox in the UI language", () => {
		useJapanese();
		const snapshot = SNAPSHOTS.full as InterfaceSnapshot;
		const ask = (snapshot.asks ?? []).find((item) => item.blocking);
		expect(ask).toBeDefined();
		if (!ask) {
			return;
		}
		const unowned = { ...ask, agentId: null, id: "unowned-ask" };
		const quiet = { asks: [], threads: [] };
		const first = actAnnouncement(null, new Map(), [], quiet, FIXTURE_NOW);
		const { sentence } = actAnnouncement(
			first.state,
			new Map(),
			[unowned],
			quiet,
			FIXTURE_NOW
		);
		expect(sentence).not.toBeNull();
		expect(sentence).not.toContain("Inbox");
		expect(sentence).toContain("ア");
	});

	test("a worker's desk label is one message", () => {
		useJapanese();
		const worker = {
			current: { title: "Fix login" },
			name: "Ada",
			state: "working",
		} as Parameters<typeof deskLabel>[0];
		const label = deskLabel(worker);
		expect(label).toStartWith("Ada, ");
		expect(label).toContain("Fix login");
		expect(label).not.toContain("working on");
		expect(deskLabel({ ...worker, current: undefined })).not.toContain(
			"no tasks yet"
		);
	});
});
