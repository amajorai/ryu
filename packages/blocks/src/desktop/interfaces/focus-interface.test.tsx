import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusInterface } from "./focus-interface.tsx";
import {
	buildFocusQueue,
	focusAge,
	focusAgentLine,
	focusCursorAt,
	focusKeyAction,
	focusPosition,
	focusReason,
	focusRuns,
	initialFocusCursor,
	resolveFocusIndex,
} from "./focus-model.ts";

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: ago(60),
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-pinned",
			lastMessage: "Pinned reply.",
			pinned: true,
			projectId: "project-site",
			title: "Pinned plan",
			updatedAt: ago(300),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
		thread({
			id: "thread-blank",
			lastMessageRole: null,
			messageCount: 0,
			title: "Blank page",
			updatedAt: ago(900),
		}),
	],
	version: 1,
};

const EXPECTED_ORDER = [
	"thread-flaky",
	"thread-pinned",
	"thread-notes",
	"thread-triage",
	"thread-loose",
	"thread-blank",
];

describe("focus model", () => {
	test("orders the queue by urgency, pinned first, then recency", () => {
		const queue = buildFocusQueue(SNAPSHOT);
		expect(queue.map((item) => item.thread.id)).toEqual(EXPECTED_ORDER);
		expect(queue.map((item) => item.status)).toEqual([
			"attention",
			"your-turn",
			"your-turn",
			"working",
			"waiting",
			"quiet",
		]);
		expect(queue[1]?.group?.name).toBe("Website");
		expect(queue[0]?.agents.map((agent) => agent.name)).toEqual(["Grace"]);
	});

	test("a cursor follows its thread and falls back to its neighbour", () => {
		const queue = buildFocusQueue(SNAPSHOT);
		const cursor = focusCursorAt(queue, 2);
		expect(cursor).toEqual({ id: "thread-notes", index: 2, kind: "thread" });

		const reordered = buildFocusQueue({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) =>
				item.id === "thread-notes" ? { ...item, running: true } : item
			),
		});
		expect(reordered[resolveFocusIndex(reordered, cursor)]?.thread.id).toBe(
			"thread-notes"
		);

		const without = buildFocusQueue({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-notes"),
		});
		expect(resolveFocusIndex(without, cursor)).toBe(2);
		expect(resolveFocusIndex(queue, { kind: "done" })).toBe(queue.length);
		expect(focusCursorAt(queue, 99)).toEqual({ kind: "done" });
		expect(focusCursorAt(queue, -4)).toMatchObject({ id: "thread-flaky" });
	});

	test("starts on the open thread when the host has one", () => {
		const queue = buildFocusQueue(SNAPSHOT);
		expect(initialFocusCursor(queue, "thread-loose")).toMatchObject({
			id: "thread-loose",
			index: 4,
		});
		expect(initialFocusCursor(queue, "missing")).toMatchObject({
			id: "thread-flaky",
		});
		expect(initialFocusCursor([], null)).toEqual({ kind: "done" });
	});

	test("labels position, runs, people, age, and reasons", () => {
		const queue = buildFocusQueue(SNAPSHOT);
		expect(focusPosition(2, 9)).toBe("3 of 9");
		expect(focusPosition(9, 9)).toBe("All 9 seen");
		expect(focusPosition(0, 0)).toBe("Queue empty");
		expect(
			focusRuns(queue).map((run) => [run.status, run.items.length])
		).toEqual([
			["attention", 1],
			["your-turn", 2],
			["working", 1],
			["waiting", 1],
			["quiet", 1],
		]);
		const [ada, grace] = SNAPSHOT.agents;
		expect(focusAgentLine([])).toBe("No agent");
		expect(ada && grace ? focusAgentLine([ada, grace]) : "").toBe(
			"Ada and Grace"
		);
		expect(ada && grace ? focusAgentLine([ada, grace, ada]) : "").toBe(
			"Ada +2"
		);
		expect(focusAge(ago(0), NOW)).toBe("just now");
		expect(focusAge(ago(18), NOW)).toBe("18m ago");
		expect(queue[0] ? focusReason(queue[0]) : "").toContain("failed");
		expect(queue[2] ? focusReason(queue[2]) : "").toBe("Ada replied");
	});

	test("maps plain keys to actions and ignores modified ones", () => {
		const plain = {
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
		};
		expect(focusKeyAction({ ...plain, key: "j" })).toBe("next");
		expect(focusKeyAction({ ...plain, key: "ArrowRight" })).toBe("next");
		expect(focusKeyAction({ ...plain, key: "k" })).toBe("previous");
		expect(focusKeyAction({ ...plain, key: "ArrowLeft" })).toBe("previous");
		expect(focusKeyAction({ ...plain, key: "Enter" })).toBe("open");
		expect(focusKeyAction({ ...plain, key: "Escape" })).toBe("back");
		expect(focusKeyAction({ ...plain, key: "Home" })).toBe("first");
		expect(focusKeyAction({ ...plain, key: "End" })).toBe("last");
		expect(focusKeyAction({ ...plain, key: "x" })).toBeNull();
		expect(focusKeyAction({ ...plain, key: "j", metaKey: true })).toBeNull();
	});
});

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function button(container: HTMLElement, name: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			(
				candidate.getAttribute("aria-label") ?? candidate.textContent
			)?.trim() === name
	);
}

async function press(key: string, target: EventTarget = document.body) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function position(container: HTMLElement) {
	return container.querySelector("[aria-live='polite']")?.textContent ?? "";
}

/** The card title that is entering (motion may keep the leaving one briefly). */
function cardTitle(container: HTMLElement) {
	const titles = [
		...container.querySelectorAll("[data-testid='focus-card'] h2"),
	];
	return titles.at(-1)?.textContent ?? "";
}

/** A host that opens and closes threads like the desktop does. */
function Host({
	onCall,
	snapshot = SNAPSHOT,
}: {
	onCall: (call: string) => void;
	snapshot?: InterfaceSnapshot;
}) {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const port: InterfacePort = {
		closeThread: () => {
			onCall("close");
			setActiveThreadId(null);
		},
		openThread: (threadId) => {
			onCall(`open:${threadId}`);
			setActiveThreadId(threadId);
		},
		startThread: (input) => onCall(`start:${JSON.stringify(input)}`),
	};
	const threadView: ReactNode = activeThreadId ? (
		<section data-testid="host-chat">chat {activeThreadId}</section>
	) : null;
	return (
		<FocusInterface
			activeThreadId={activeThreadId}
			loading={false}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

describe("FocusInterface", () => {
	test("renders the most urgent thread first, as one card", () => {
		const html = renderToStaticMarkup(
			<FocusInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-focus"');
		expect(html).toContain("Flaky test");
		expect(html).toContain("Needs attention");
		expect(html).toContain("1 of 6");
		expect(html).toContain("The run stopped.");
		expect(html).toContain("Up next");
		expect(html).not.toContain("Crash triage</h2>");
		expect(html.match(/data-testid="focus-card"/g)?.length).toBe(1);
	});

	test("shows a skeleton while loading and caught up when empty", () => {
		const loading = renderToStaticMarkup(
			<FocusInterface
				activeThreadId={null}
				loading
				params={{}}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(loading).toContain('data-testid="focus-skeleton"');
		expect(loading).not.toContain("Flaky test");

		const empty = renderToStaticMarkup(
			<FocusInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(empty).toContain("You&#x27;re caught up");
		expect(empty).toContain("Queue empty");
		expect(empty).not.toContain("Start over");
	});

	test("steps with buttons and J/K/arrow keys", async () => {
		const view = await mount(<Host onCall={() => undefined} />);
		expect(cardTitle(view.container)).toBe("Flaky test");
		expect(button(view.container, "Previous")?.disabled).toBe(true);

		await click(button(view.container, "Next"));
		expect(position(view.container)).toBe("2 of 6");
		expect(cardTitle(view.container)).toBe("Pinned plan");

		await press("j");
		await press("ArrowRight");
		expect(position(view.container)).toBe("4 of 6");
		expect(cardTitle(view.container)).toBe("Crash triage");

		await press("k");
		await press("ArrowLeft");
		expect(position(view.container)).toBe("2 of 6");

		await press("j", document.body);
		await press("J");
		await press("ArrowLeft", document.body);
		expect(position(view.container)).toBe("3 of 6");
		await view.dispose();
	});

	test("the queue strip jumps straight to a thread", async () => {
		const view = await mount(<Host onCall={() => undefined} />);
		const segments = view.container.querySelectorAll(
			"nav[aria-label='Queue'] button"
		);
		expect(segments.length).toBe(6);
		expect(segments[0]?.getAttribute("aria-current")).toBe("step");
		await click(segments[4]);
		expect(position(view.container)).toBe("5 of 6");
		expect(cardTitle(view.container)).toBe("Loose ends");
		expect(segments[4]?.getAttribute("aria-label")).toBe(
			"5 of 6: Loose ends, Waiting on agent"
		);
		await view.dispose();
	});

	test("the queue strip is one tab stop with its own arrow keys", async () => {
		const view = await mount(<Host onCall={() => undefined} />);
		const segments = () => [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"nav[aria-label='Queue'] button"
			),
		];
		const segment = (index: number): HTMLButtonElement => {
			const found = segments()[index];
			if (!found) {
				throw new Error(`Expected segment ${index}`);
			}
			return found;
		};
		const tabbable = () =>
			segments().filter((candidate) => candidate.tabIndex === 0);
		expect(tabbable().length).toBe(1);
		expect(tabbable()[0]).toBe(segment(0));

		await act(async () => segment(0).focus());
		await press("ArrowRight", segment(0));
		// One step, from the strip's own handler only (not the page shortcut too).
		expect(position(view.container)).toBe("2 of 6");
		expect(document.activeElement === segment(1)).toBe(true);
		expect(tabbable()[0]).toBe(segment(1));

		await press("End", segment(1));
		expect(position(view.container)).toBe("6 of 6");
		expect(document.activeElement === segment(5)).toBe(true);
		await press("j", segment(5));
		expect(position(view.container)).toBe("6 of 6");
		await press("Home", segment(5));
		expect(position(view.container)).toBe("1 of 6");
		await view.dispose();
	});

	test("opens the host's chat in the focus frame and steps through it", async () => {
		const calls: string[] = [];
		const view = await mount(<Host onCall={(call) => calls.push(call)} />);
		await click(button(view.container, "Open thread"));
		expect(calls).toEqual(["open:thread-flaky"]);
		const frame = view.container.querySelector("[data-testid='focus-frame']");
		expect(frame?.querySelector("[data-testid='host-chat']")?.textContent).toBe(
			"chat thread-flaky"
		);
		expect(frame?.querySelector("h2")?.textContent).toBe("Flaky test");
		expect(position(view.container)).toBe("1 of 6");
		// Only the host's chat is shown: Focus adds no composer of its own.
		expect(view.container.querySelector("textarea")).toBeNull();

		await click(button(view.container, "Next thread"));
		expect(calls.at(-1)).toBe("open:thread-pinned");
		await press("j");
		expect(calls.at(-1)).toBe("open:thread-notes");
		expect(position(view.container)).toBe("3 of 6");

		// Keys typed inside the host's conversation belong to it.
		const chat = view.container.querySelector("[data-testid='host-chat']");
		await press("j", chat ?? document.body);
		expect(calls.at(-1)).toBe("open:thread-notes");

		await press("Escape");
		expect(calls.at(-1)).toBe("close");
		expect(view.container.querySelector("[data-testid='focus-frame']")).toBe(
			null
		);
		// Back in the queue on the thread that was open.
		expect(cardTitle(view.container)).toBe("Release notes");

		await click(button(view.container, "Open thread"));
		await click(button(view.container, "Back to queue"));
		expect(calls.slice(-2)).toEqual(["open:thread-notes", "close"]);
		await view.dispose();
	});

	test("finishing the queue offers a composer that starts a thread on submit", async () => {
		const calls: string[] = [];
		const view = await mount(<Host onCall={(call) => calls.push(call)} />);
		for (const _ of EXPECTED_ORDER.slice(1)) {
			await press("j");
		}
		expect(position(view.container)).toBe("6 of 6");
		await click(button(view.container, "Finish"));
		expect(view.container.querySelector("[data-testid='focus-done']")).not.toBe(
			null
		);
		expect(view.container.textContent).toContain("You're caught up");
		expect(position(view.container)).toBe("All 6 seen");

		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the composer");
		}
		// Shortcuts never fire while typing.
		await act(async () => field.focus());
		await press("k", field);
		expect(view.container.querySelector("[data-testid='focus-done']")).not.toBe(
			null
		);
		expect(calls.some((call) => call.startsWith("start:"))).toBe(false);

		await typeInto(field, "Plan the next sprint");
		const form = field.closest("form");
		await act(async () => {
			form?.requestSubmit();
		});
		expect(calls.at(-1)).toBe(
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Plan the next sprint" })}`
		);

		await act(async () => field.blur());
		await click(button(view.container, "Start over"));
		expect(position(view.container)).toBe("1 of 6");
		await view.dispose();
	});

	test("K from the caught-up card returns to the last thread", async () => {
		const view = await mount(<Host onCall={() => undefined} />);
		await click(
			view.container.querySelectorAll("nav[aria-label='Queue'] button")[5]
		);
		await press("j");
		expect(view.container.querySelector("[data-testid='focus-done']")).not.toBe(
			null
		);
		await press("j");
		expect(position(view.container)).toBe("All 6 seen");
		await press("k");
		expect(position(view.container)).toBe("6 of 6");
		expect(cardTitle(view.container)).toBe("Blank page");
		expect(view.container.textContent).toContain("No messages yet");
		await view.dispose();
	});

	test("Home and End jump to either end of the queue", async () => {
		const view = await mount(<Host onCall={() => undefined} />);
		await press("End");
		expect(position(view.container)).toBe("All 6 seen");
		expect(view.container.querySelector("[data-testid='focus-done']")).not.toBe(
			null
		);
		await press("Home");
		expect(position(view.container)).toBe("1 of 6");
		await view.dispose();
	});
});
