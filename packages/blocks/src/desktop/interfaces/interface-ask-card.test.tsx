import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { actTotals } = await import("./game3d-acts.ts");
const {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} = await import("./interface-ask-card.tsx");

const { ActPlateButton, offStageLabel, offStageText, openerLabel } =
	await import("./game3d-signs.tsx");
const { apprenticeCounts, apprenticeSpecs } = await import(
	"./game3d-apprentice.tsx"
);
const { progressText, queuePlateText, timerLevel } = await import(
	"./game3d-meters.tsx"
);
const { alarmTone } = await import("./game3d-alarm.tsx");

import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";

afterAll(() => {
	GlobalRegistrator.unregister();
});

interface Spy {
	answers: [string, string][];
	inbox: number;
	opened: string[];
	port: InterfacePort;
}

function spyPort(withAnswer = true): Spy {
	const spy: Spy = {
		answers: [],
		inbox: 0,
		opened: [],
		port: {
			closeThread: () => undefined,
			openInbox: () => {
				spy.inbox += 1;
			},
			openThread: (id) => {
				spy.opened.push(id);
			},
			startThread: () => undefined,
		},
	};
	if (withAnswer) {
		spy.port.answerAsk = async (askId, choiceId) => {
			spy.answers.push([askId, choiceId]);
		};
	}
	return spy;
}

let setSnapshotOutside: ((snapshot: InterfaceSnapshot) => void) | null = null;
const parentKeys: string[] = [];

/** A tiny game: fallback heading, queue, need-you, queue button, cards. */
function Game({
	initial,
	openRef,
	port,
}: {
	initial: InterfaceSnapshot;
	openRef?: { current: (() => void) | null };
	port: InterfacePort;
}) {
	const [snapshot, setSnapshot] = useState(initial);
	setSnapshotOutside = setSnapshot;
	const heading = useRef<HTMLHeadingElement>(null);
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const unowned = unownedAsks(snapshot);
	const cards = useActCards({
		acts,
		clock: FIXTURE_CLOCK,
		fallbackFocus: heading,
		nowMs: FIXTURE_NOW,
		port,
		snapshot,
	});
	const totals = actTotals(snapshot, acts);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a game's root key handler, spied on.
		<div onKeyDown={(event) => parentKeys.push(event.key)}>
			<h1 className="sr-only" ref={heading} tabIndex={-1}>
				Game
			</h1>
			<NeedYouButton
				onAsk={cards.openAsk}
				snapshot={snapshot}
				totals={totals}
			/>
			<QueueButton
				acts={acts}
				narrow={false}
				nowMs={FIXTURE_NOW}
				onAsk={cards.openAsk}
				onBlocker={cards.openBlocker}
				openRef={openRef}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
			<AskQueueList
				acts={acts}
				clock={FIXTURE_CLOCK}
				nowMs={FIXTURE_NOW}
				onAsk={cards.openAsk}
				onBlocker={cards.openBlocker}
				snapshot={snapshot}
				unowned={unowned}
			/>
			<ActAgentList
				acts={acts}
				clock={FIXTURE_CLOCK}
				nowMs={FIXTURE_NOW}
				onAsk={cards.openAsk}
				onBlocker={cards.openBlocker}
				onOpenThread={port.openThread}
				snapshot={snapshot}
			/>
			<BlindSpotCaption snapshot={snapshot} />
			<ActAnnouncer sentence={null} />
			{cards.element}
		</div>
	);
}

let unmount: (() => void) | null = null;

async function flush(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mount(
	snapshot: InterfaceSnapshot,
	port: InterfacePort,
	openRef?: { current: (() => void) | null }
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() =>
		root.render(<Game initial={snapshot} openRef={openRef} port={port} />)
	);
	unmount = () => {
		act(() => root.unmount());
		container.remove();
	};
	await flush();
	return container;
}

afterEach(() => {
	unmount?.();
	unmount = null;
	parentKeys.length = 0;
});

function queueButton(name: string): HTMLButtonElement {
	const found = [
		...document.querySelectorAll<HTMLButtonElement>(
			"[data-ask-queue='reveal'] button"
		),
	].find((button) => button.getAttribute("aria-label")?.startsWith(name));
	if (!found) {
		throw new Error(`no queue button ${name}`);
	}
	return found;
}

function card(): HTMLElement | null {
	return document.querySelector("[data-ask-card]");
}

function cardButton(label: string): HTMLButtonElement | undefined {
	return [...(card()?.querySelectorAll("button") ?? [])].find(
		(button) => button.textContent === label
	);
}

async function click(element: HTMLElement | undefined | null) {
	act(() => element?.click());
	await flush();
}

const ADA =
	"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.";
const BO =
	"Bo asks: Which DB to use? Waited 3 minutes. Expires within 7 minutes.";
// A's askAriaLabel includes the gate's risk tag (spec §7.2 test 14 omits it).
const GATE =
	"Inbox asks: Workflow gate: Deploy. Waited 20 minutes. Risk: workflow.";

describe("AskQueueList (test 14)", () => {
	test("groups in order, named by askAriaLabel / blockerAriaLabel", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const queue = document.querySelector("[data-ask-queue='reveal']");
		const headings = [...(queue?.querySelectorAll("h3") ?? [])].map(
			(h) => h.textContent
		);
		expect(headings).toEqual([
			"3 asks need you",
			"3 runs stopped",
			"1 suggestion",
			"2 answers ready",
		]);
		const lists = [...(queue?.querySelectorAll("ol") ?? [])].map((list) =>
			[...list.querySelectorAll("button")].map((button) =>
				button.getAttribute("aria-label")
			)
		);
		expect(lists[0]).toEqual([BO, GATE, ADA]);
		expect(lists[1]?.[0]).toBe("Di stopped: Tests failed, 20 minutes ago.");
		expect(lists[1]?.[1]).toBe("Ed stopped: Interrupted, about 1 hour ago.");
		expect(lists[2]).toEqual([
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours.",
		]);
		expect(lists[3]?.[0]?.startsWith("Gu has an answer ready")).toBe(true);
		expect(lists[3]?.[1]?.startsWith("Ju has an answer ready")).toBe(true);
	});

	test("the gate's button opens its card; Open calls openInbox", async () => {
		const spy = spyPort();
		await mount(usefulStateFixture(), spy.port);
		await click(queueButton("Inbox asks"));
		expect(card()?.textContent).toContain("Workflow gate: Deploy");
		await click(cardButton("Open"));
		expect(spy.inbox).toBe(1);
	});

	test("the third stopped run opens Di's routine blocker card", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const stopped = [
			...document.querySelectorAll<HTMLButtonElement>(
				"[data-ask-queue='reveal'] [data-blocker-thread]"
			),
		];
		await click(stopped[2]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup failed");
	});

	test("12 unread answers: 5 then Show 7 more", async () => {
		const base = usefulStateFixture();
		const reply = (base.asks ?? []).find((ask) => ask.kind === "reply");
		if (!reply) {
			throw new Error("fixture has no reply");
		}
		const replies = Array.from({ length: 12 }, (_, index) => ({
			...reply,
			id: `reply:extra-${index}`,
		}));
		const snapshot = {
			...base,
			asks: [
				...(base.asks ?? []).filter((ask) => ask.kind !== "reply"),
				...replies,
			],
		};
		await mount(snapshot, spyPort().port);
		const queue = document.querySelector("[data-ask-queue='reveal']");
		const answers = [...(queue?.querySelectorAll("section") ?? [])].at(-1);
		expect(answers?.querySelectorAll("li")).toHaveLength(5);
		const more = [...(answers?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "Show 7 more"
		);
		more?.focus();
		await click(more);
		expect(answers?.querySelectorAll("li")).toHaveLength(12);
		// Focus moves to the first revealed answer, not to the page body.
		const items = [...(answers?.querySelectorAll("li button") ?? [])];
		expect(document.activeElement).toBe(items[5] ?? null);
	});

	test("live permission gives Ada two buttons with different names", async () => {
		await mount(usefulStateFixture({ livePermission: true }), spyPort().port);
		const ada = [
			...document.querySelectorAll("[data-ask-queue='reveal'] button"),
		]
			.map((button) => button.getAttribute("aria-label") ?? "")
			.filter((label) => label.startsWith("Ada asks"));
		expect(ada).toHaveLength(2);
		expect(new Set(ada).size).toBe(2);
	});

	test("Queue · 9 is visible and opens the sheet; choosing Gu opens Gu's card", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const button = document.querySelector<HTMLButtonElement>(
			"[data-queue-button]"
		);
		expect(button?.textContent).toBe("Queue · 9");
		expect(button?.closest(".sr-only")).toBeNull();
		await click(button);
		const sheet = document.querySelector("[data-ask-queue='sheet']");
		expect(sheet).not.toBeNull();
		const gu = [...(sheet?.querySelectorAll("button") ?? [])].find((b) =>
			b.getAttribute("aria-label")?.startsWith("Gu")
		);
		const headings = [...(sheet?.querySelectorAll("h3") ?? [])].map(
			(h) => h.textContent
		);
		expect(headings).toEqual([
			"3 asks need you",
			"3 runs stopped",
			"1 suggestion",
			"2 answers ready",
		]);
		await click(gu as HTMLButtonElement);
		expect(document.querySelector("[data-ask-queue='sheet']")).toBeNull();
		expect(card()?.textContent).toContain("Edited 3 files");
		await click(cardButton("Close"));
		await flush(80);
		expect(document.activeElement?.hasAttribute("data-queue-button")).toBe(
			true
		);
	});

	test("Escape closes the Queue list; the game's handler never sees it", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		await click(
			document.querySelector<HTMLButtonElement>("[data-queue-button]")
		);
		const sheet = document.querySelector("[data-ask-queue='sheet']");
		// A queue item button, inside the list's own key-isolating root.
		const inside = sheet?.querySelector(
			"button[aria-label]"
		) as HTMLButtonElement;
		expect(inside.closest("[data-ask-queue='sheet']")).toBe(sheet);
		inside.focus();
		act(() => {
			inside.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		await flush(80);
		expect(document.querySelector("[data-ask-queue='sheet']")).toBeNull();
		expect(parentKeys).toEqual([]);
	});

	test("an emptied queue clears the tally opener and never pops up later", async () => {
		const base = usefulStateFixture();
		const openRef: { current: (() => void) | null } = { current: null };
		await mount(base, spyPort().port, openRef);
		expect(openRef.current).not.toBeNull();
		act(() =>
			setSnapshotOutside?.({
				...base,
				asks: [],
				threads: base.threads.map((t) => ({ ...t, blocker: null })),
			})
		);
		await flush();
		expect(openRef.current).toBeNull();
		expect(document.querySelector("[data-queue-button]")).toBeNull();
		act(() => setSnapshotOutside?.(base));
		await flush();
		expect(document.querySelector("[data-ask-queue='sheet']")).toBeNull();
	});

	test("no queue button when nothing is queued", async () => {
		const base = usefulStateFixture();
		await mount(
			{
				...base,
				asks: [],
				threads: base.threads.map((t) => ({ ...t, blocker: null })),
			},
			spyPort().port
		);
		expect(document.querySelector("[data-queue-button]")).toBeNull();
	});
});

describe("AskCard (tests 13, 13b, 13h)", () => {
	test("a dialog with a name; Ada's target, never the arguments", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		await click(queueButton("Ada asks"));
		const dialog = document.querySelector("[role='dialog']");
		expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
		const text = card()?.textContent ?? "";
		expect(text).toContain("Can I run shell.run now?");
		expect(text).toContain("Target: deploy.sh");
		expect(text).not.toContain("fixture-secret");
		expect(text).not.toContain("TOKEN");
		expect(text).not.toContain("env");
		expect(
			card()?.querySelectorAll("[aria-label='Risk'] li").length
		).toBeLessThanOrEqual(2);
		expect(document.activeElement?.textContent).toBe("Open");
	});

	test("a destructive approve needs a confirm; focus goes to Cancel", async () => {
		const spy = spyPort();
		await mount(usefulStateFixture(), spy.port);
		await click(queueButton("Ada asks"));
		await click(cardButton("Approve"));
		expect(spy.answers).toEqual([]);
		expect(card()?.textContent).toContain("Confirm Approve?");
		expect(document.activeElement?.textContent).toBe("Cancel");
		await click(cardButton("Confirm Approve"));
		expect(spy.answers).toHaveLength(1);
	});

	test("the confirm step is announced, and Cancel returns focus to its choice", async () => {
		const spy = spyPort();
		await mount(usefulStateFixture(), spy.port);
		await click(queueButton("Ada asks"));
		const approve = cardButton("Approve");
		await click(approve);
		const group = card()?.querySelector("[data-ask-confirm]");
		expect(group?.getAttribute("role")).toBe("group");
		const prompt = document.getElementById(
			group?.getAttribute("aria-labelledby") ?? ""
		);
		expect(prompt?.textContent).toBe("Confirm Approve?");
		const cancel = cardButton("Cancel");
		expect(cancel?.getAttribute("aria-describedby")).toBe(
			prompt?.id ?? "missing"
		);
		expect(
			cardButton("Confirm Approve")?.getAttribute("aria-describedby")
		).toBe(prompt?.id ?? "missing");
		await click(cancel);
		expect(card()?.querySelector("[data-ask-confirm]")).toBeNull();
		expect(document.activeElement?.textContent).toBe("Approve");
		expect(spy.answers).toEqual([]);
	});

	test("at most 2 risk tags, labelled by riskTagLabel", async () => {
		const base = usefulStateFixture();
		const asks = (base.asks ?? []).map((ask) =>
			ask.id === "approval:wf-deploy"
				? { ...ask, riskTags: ["force_push", "agent-configuration", "delete"] }
				: ask
		);
		await mount({ ...base, asks }, spyPort().port);
		await click(queueButton("Inbox asks"));
		const tags = [
			...(card()?.querySelectorAll("[aria-label='Risk'] li") ?? []),
		].map((li) => li.textContent);
		expect(tags).toEqual(["force push", "agent configuration"]);
	});

	test("without answerAsk there are no choices, only Open", async () => {
		await mount(usefulStateFixture(), spyPort(false).port);
		await click(queueButton("Ada asks"));
		expect(cardButton("Approve")).toBeUndefined();
		expect(cardButton("Open")).toBeDefined();
	});

	test("expiry upper bounds read 'up to'", async () => {
		await mount(usefulStateFixture({ livePermission: true }), spyPort().port);
		await click(queueButton("Ada asks: Allow"));
		expect(card()?.textContent).toContain("up to 3m");
		await click(cardButton("Close"));
		await click(queueButton("Bo asks"));
		expect(card()?.textContent).toContain("up to 7m");
	});

	test("redacted: Open only, the hidden-details line, no answerAsk", async () => {
		const spy = spyPort();
		await mount(usefulStateFixture({ privacy: "redacted" }), spy.port);
		await click(queueButton("Ada"));
		expect(cardButton("Approve")).toBeUndefined();
		expect(cardButton("Reject")).toBeUndefined();
		expect(card()?.textContent).not.toContain("Target:");
		expect(card()?.textContent).toContain(
			"Details are hidden while work details are hidden. Open to answer."
		);
		for (const button of card()?.querySelectorAll("button") ?? []) {
			if (button.textContent !== "Open" && button.textContent !== "Close") {
				await click(button);
			}
		}
		expect(spy.answers).toEqual([]);
	});

	test("switching to redacted cancels an open confirm", async () => {
		const spy = spyPort();
		const full = usefulStateFixture();
		await mount(full, spy.port);
		await click(queueButton("Ada asks"));
		await click(cardButton("Approve"));
		expect(card()?.textContent).toContain("Confirm Approve?");
		act(() => setSnapshotOutside?.({ ...full, privacy: "redacted" }));
		await flush();
		expect(card()?.textContent ?? "").not.toContain("Confirm Approve?");
		expect(spy.answers).toEqual([]);
	});

	test("the ask leaving shows No longer waiting, disables choices, focuses Close", async () => {
		const spy = spyPort();
		const full = usefulStateFixture();
		await mount(full, spy.port);
		await click(queueButton("Ada asks"));
		await click(cardButton("Approve"));
		const ada = queueButton("Ada asks").getAttribute("data-ask-id");
		act(() =>
			setSnapshotOutside?.({
				...full,
				asks: (full.asks ?? []).filter((ask) => ask.id !== ada),
			})
		);
		await flush();
		expect(card()?.textContent).toContain("No longer waiting");
		expect(card()?.textContent ?? "").not.toContain("Confirm Approve?");
		expect(cardButton("Approve")?.disabled).toBe(true);
		expect(document.activeElement?.textContent).toBe("Close");
		await click(cardButton("Approve"));
		expect(spy.answers).toEqual([]);
	});

	test("Escape closes only the card; the game's handler never sees it or digits", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const opener = queueButton("Bo asks");
		opener.focus();
		await click(opener);
		const active = document.activeElement as HTMLElement;
		// The keys really are pressed inside the card.
		expect(card()?.contains(active)).toBe(true);
		act(() => {
			active.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "1" })
			);
			active.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		await flush(80);
		expect(card()).toBeNull();
		expect(parentKeys).toEqual([]);
		expect(document.activeElement).toBe(opener);
	});

	test("after an answer removes the opener, focus goes to the next queue button", async () => {
		const full = usefulStateFixture();
		await mount(full, spyPort().port);
		const opener = queueButton("Bo asks");
		opener.focus();
		await click(opener);
		const bo = opener.getAttribute("data-ask-id");
		act(() =>
			setSnapshotOutside?.({
				...full,
				asks: (full.asks ?? []).filter((ask) => ask.id !== bo),
			})
		);
		await flush();
		expect(opener.isConnected).toBe(false);
		await click(cardButton("Close"));
		await flush(80);
		// The gate now sits where Bo's button was.
		expect(document.activeElement?.getAttribute("aria-label")).toBe(GATE);
	});

	test("with no queue button left, focus goes to the heading", async () => {
		const full = usefulStateFixture();
		const only = (full.asks ?? []).filter((ask) => ask.kind === "question");
		const snapshot = {
			...full,
			asks: only,
			threads: full.threads.map((t) => ({ ...t, blocker: null })),
		};
		await mount(snapshot, spyPort().port);
		const opener = queueButton("Bo asks");
		opener.focus();
		await click(opener);
		act(() => setSnapshotOutside?.({ ...snapshot, asks: [] }));
		await flush();
		await click(cardButton("Close"));
		await flush(80);
		expect(document.activeElement?.textContent).toBe("Game");
		expect(document.activeElement).not.toBe(document.body);
	});
});

describe("ActAgentList and announcer", () => {
	test("rows are described by act sentences; Ada's Answer opens her card", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const ada = document.querySelector<HTMLButtonElement>(
			"[data-act-agent-list] li:has(button) button"
		);
		const describedBy = ada?.getAttribute("aria-describedby");
		expect(
			describedBy ? document.getElementById(describedBy)?.textContent : null
		).toBeTruthy();
		const rows = [...document.querySelectorAll("[data-act-agent-list] li")];
		const adaRow = rows.find((row) => row.textContent?.startsWith("Ada"));
		const answer = [...(adaRow?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "Answer"
		);
		await click(answer);
		expect(card()?.textContent).toContain("Can I run shell.run now?");
	});

	test("Di's row has two Details buttons", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const rows = [...document.querySelectorAll("[data-act-agent-list] li")];
		const di = rows.find((row) => row.textContent?.startsWith("Di"));
		const details = [...(di?.querySelectorAll("button") ?? [])].filter(
			(b) => b.textContent === "Details"
		);
		expect(details).toHaveLength(2);
		await click(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup");
	});

	test("the announcer is always mounted, sr-only and polite", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		const region = document.querySelector("[data-act-announcer]");
		expect(region?.getAttribute("aria-live")).toBe("polite");
		expect(region?.className).toContain("sr-only");
	});

	test("the blind-spot caption", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		expect(document.querySelector("[data-blind-spot]")?.textContent).toBe(
			"Some questions and prompts only show in their chat"
		);
	});

	test("3 need you opens Bo's card first", async () => {
		await mount(usefulStateFixture(), spyPort().port);
		await click(document.querySelector<HTMLButtonElement>("[data-need-you]"));
		expect(card()?.textContent).toContain("Which DB to use?");
	});
});

function render(node: ReactElement): {
	container: HTMLElement;
	unmount: () => void;
} {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(node));
	return {
		container,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const LOOKS = {
	body: "x",
	collar: "x",
	hair: "x",
	hairStyle: 0,
	iris: "x",
	skin: "x",
};

describe("act plates", () => {
	const snapshot = usefulStateFixture();
	const asks = snapshot.asks ?? [];
	const replies = asks.filter((ask) => ask.kind === "reply");

	test("a focusable plate is an iso target; a pointer-only one is not", () => {
		let opened = 0;
		const focusable = render(
			<ActPlateButton
				focusable
				kind="unread"
				label="Ju has an answer ready"
				onActivate={() => (opened += 1)}
			>
				1
			</ActPlateButton>
		);
		const button = focusable.container.querySelector("button");
		expect(button?.hasAttribute("data-iso-target")).toBe(true);
		expect(button?.tabIndex).toBe(0);
		act(() => button?.click());
		expect(opened).toBe(1);
		focusable.unmount();
		const pointer = render(
			<ActPlateButton
				focusable={false}
				kind="notice"
				label="Inbox asks"
				onActivate={() => undefined}
			/>
		);
		const plain = pointer.container.querySelector("button");
		expect(plain?.hasAttribute("data-iso-target")).toBe(false);
		expect(plain?.tabIndex).toBe(-1);
		pointer.unmount();
	});

	test("a tally plate says whose it is", () => {
		const view = render(
			<ActPlateButton
				budgeted="tally"
				focusable
				kind="tally"
				label="6 more agents. Open the queue"
				onActivate={() => undefined}
				tally="off"
			>
				+6
			</ActPlateButton>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("data-tally")).toBe("off");
		expect(button?.getAttribute("data-budgeted-overlay")).toBe("tally");
		expect(button?.hasAttribute("data-you-spot")).toBe(false);
		view.unmount();
	});

	test("openers are named by askAriaLabel plus and N more", () => {
		const label = openerLabel(replies, "Gu", FIXTURE_NOW);
		expect(label.endsWith(`and ${replies.length - 1} more`)).toBe(
			replies.length > 1
		);
		expect(openerLabel([], null, FIXTURE_NOW)).toBe("");
	});

	test("tally words", () => {
		expect(
			offStageText({
				asks: 0,
				byAct: { delivering: 1, idle: 2, limited: 1, working: 2 },
				count: 6,
			})
		).toBe("+6: 1 limited, 2 working, 1 delivering, 2 idle");
		expect(offStageLabel(6)).toBe("6 more agents. Open the queue");
	});

	test("meters read real progress and the queue plate's wait", () => {
		expect(progressText(null)).toBeNull();
		expect(
			progressText({ done: 3, kind: "plan", source: "messages", total: 7 })
		).toBe("3/7");
		expect(
			progressText({
				done: 15,
				kind: "estimate",
				source: "estimate",
				total: 20,
			})
		).toBe("~");
		const since = new Date(FIXTURE_NOW - 14 * 60_000).toISOString();
		expect(queuePlateText("Ada", { since }, FIXTURE_NOW)).toBe("Ada · 14m");
		expect(timerLevel({ since: null }, FIXTURE_NOW)).toBe(1);
	});

	test("alarm tones", () => {
		expect(alarmTone({ kind: "command-failed" })).toBe("red");
		expect(alarmTone({ kind: "billing" })).toBe("red");
		expect(alarmTone({ kind: "interrupted" })).toBe("grey");
		expect(alarmTone({ kind: "rate-limited" })).toBe("amber");
		expect(alarmTone({ kind: "schedule-failed" })).toBe("calendar");
	});

	test("apprentices: up to 3, then +N; a failed one sits", () => {
		expect(
			apprenticeCounts({ done: 0, failed: 1, running: 2, titles: [] })
		).toEqual({
			failed: 1,
			more: 0,
			running: 2,
		});
		expect(
			apprenticeCounts({ done: 0, failed: 2, running: 4, titles: [] })
		).toEqual({
			failed: 0,
			more: 3,
			running: 3,
		});
		const specs = apprenticeSpecs({
			agentId: "cy",
			helpers: { done: 0, failed: 0, running: 2, titles: [] },
			looks: LOOKS,
			station: [1, 0, 1],
		});
		expect(specs.map((item) => [item.scale, item.plate])).toEqual([
			[0.6, false],
			[0.6, false],
		]);
	});
});

describe("useActAnnouncement repeats", () => {
	test("two identical sentences both reach the live region (cleared in between)", async () => {
		const { useActAnnouncement, useActs, ActClockProvider } = await import(
			"./use-acts.ts"
		);
		const redacted = usefulStateFixture({ privacy: "redacted" });
		const ada = (redacted.asks ?? []).find((ask) => ask.agentId === "ada");
		if (!ada) {
			throw new Error("no Ada ask");
		}
		const without = {
			...redacted,
			asks: (redacted.asks ?? []).filter((ask) => ask.id !== ada.id),
		};
		let setOuter: ((snapshot: InterfaceSnapshot) => void) | null = null;
		function Speaker() {
			const [snapshot, setSnapshot] = useState<InterfaceSnapshot>(without);
			setOuter = setSnapshot;
			const view = useActs(snapshot);
			return <ActAnnouncer sentence={useActAnnouncement(snapshot, view)} />;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() =>
			root.render(
				<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
					<Speaker />
				</ActClockProvider>
			)
		);
		const region = () =>
			container.querySelector("[data-act-announcer]")?.textContent ?? "";
		await flush();
		act(() => setOuter?.(redacted));
		await flush(150);
		const first = region();
		expect(first.startsWith("Ada asks:")).toBe(true);
		act(() => setOuter?.(without));
		await flush(150);
		// The same sentence again: the region empties first, then speaks, so
		// a screen reader hears it a second time.
		act(() =>
			setOuter?.({
				...redacted,
				asks: [...(without.asks ?? []), { ...ada, id: `${ada.id}-again` }],
			})
		);
		expect(region()).toBe("");
		await flush(150);
		expect(region()).toBe(first);
		act(() => root.unmount());
		container.remove();
	});
});
