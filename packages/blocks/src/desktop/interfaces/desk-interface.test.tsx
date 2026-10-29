import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectDeskViews,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskInterface } from "./desk-interface.tsx";
import {
	deskDefaultViewId,
	deskRelatedThreads,
	deskRow,
	deskStartInput,
	deskStatusExplanation,
	deskViewRows,
	findDeskView,
} from "./desk-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

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
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
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
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
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
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-review",
			lastMessage: "Review done.",
			runState: "failed",
			teamId: "team-design",
			title: "Design review",
			updatedAt: ago(10),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to type into");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function rowIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[data-testid^='desk-row-']")].map(
		(row) => row.getAttribute("data-testid")?.replace("desk-row-", "") ?? ""
	);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

describe("desk model", () => {
	test("opens on Needs you unless the open thread lives elsewhere", () => {
		const sections = projectDeskViews(SNAPSHOT);
		expect(deskDefaultViewId(sections, null)).toBe("needs-you");
		expect(deskDefaultViewId(sections, "thread-review")).toBe("needs-you");
		expect(deskDefaultViewId(sections, "thread-triage")).toBe("all");
		const quiet = projectDeskViews({
			...SNAPSHOT,
			threads: [thread({ id: "only", lastMessageRole: "user" })],
		});
		expect(deskDefaultViewId(quiet, null)).toBe("all");
	});

	test("sorts a view by last activity in either direction", () => {
		const sections = projectDeskViews(SNAPSHOT);
		const all = findDeskView(sections, "all");
		const ids = (sort: "newest" | "oldest") =>
			deskViewRows(SNAPSHOT, all, sort).map((row) => row.thread.id);
		expect(ids("newest")).toEqual([
			"thread-triage",
			"thread-review",
			"thread-notes",
			"thread-question",
		]);
		expect(ids("oldest")).toEqual([...ids("newest")].reverse());
	});

	test("files new conversations under the view's agent, team, or project", () => {
		const sections = projectDeskViews(SNAPSHOT);
		expect(deskStartInput(findDeskView(sections, "all"))).toEqual({});
		expect(deskStartInput(findDeskView(sections, "agent:agent-ada"))).toEqual({
			agentId: "agent-ada",
		});
		expect(deskStartInput(findDeskView(sections, "team:team-design"))).toEqual({
			teamId: "team-design",
		});
	});

	test("describes rows and finds the same agents' other threads", () => {
		const review = SNAPSHOT.threads[3];
		const question = SNAPSHOT.threads[1];
		if (!(review && question)) {
			throw new Error("fixture");
		}
		const row = deskRow(SNAPSHOT, review);
		expect(row.actorLabel).toBe("Ada +1");
		expect(row.group?.name).toBe("Design Review");
		expect(row.needsYou).toBe(true);
		expect(deskRow(SNAPSHOT, question).preview).toBe(
			"You: Can you shorten the intro?"
		);
		expect(deskRelatedThreads(SNAPSHOT, row).map((other) => other.id)).toEqual([
			"thread-triage",
			"thread-notes",
			"thread-question",
		]);
	});
	test("explains a waiting thread by who is (or is not) on it", () => {
		const question = SNAPSHOT.threads[1];
		if (!question) {
			throw new Error("fixture");
		}
		expect(deskStatusExplanation(deskRow(SNAPSHOT, question))).toBe(
			"You wrote last. Ada has not started a run yet."
		);
		const unassigned = deskRow(SNAPSHOT, { ...question, agentIds: [] });
		expect(deskStatusExplanation(unassigned)).toContain(
			"no agent is on this conversation"
		);
	});
});

describe("DeskInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], groups: [], threads: [] };
		const loading = renderToStaticMarkup(
			<DeskInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loading).toContain('data-testid="interface-desk"');
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("Move");
		const idle = renderToStaticMarkup(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(idle).toContain("No conversations yet");
		expect(idle).toContain("Start a conversation with any agent");
		// With no rows, the legend keeps only the key that still does something.
		expect(idle).not.toContain("Move");
	});

	test("switches views, sorts, opens rows, and starts in an inbox", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(rowIds(view.container)).toEqual(["thread-review", "thread-notes"]);
		// Rows carry one quiet mark, never a status pill; the label says it.
		const notes = view.container.querySelector(
			"[data-testid='desk-row-thread-notes']"
		);
		expect(notes?.querySelector("[data-slot='badge']")).toBeNull();
		expect(notes?.querySelector("[data-mark='your-turn']")).not.toBeNull();
		expect(notes?.getAttribute("aria-label")).toContain("Your turn");

		await click(view.container.querySelector("[data-testid='desk-view-all']"));
		expect(rowIds(view.container)).toHaveLength(4);
		const sortToggle = view.container.querySelector(
			"[data-testid='desk-sort']"
		);
		expect(sortToggle?.getAttribute("aria-label")).toContain(
			"Sorted newest first"
		);
		await click(sortToggle);
		expect(rowIds(view.container)[0]).toBe("thread-question");

		await click(
			view.container.querySelector("[data-testid='desk-row-thread-notes']")
		);
		expect(calls).toContain("open:thread-notes");

		await click(
			view.container.querySelector("[data-testid='desk-view-agent:agent-ada']")
		);
		await click(
			view.container.querySelector("[data-testid='desk-new-conversation']")
		);
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-ada"}');
		await view.dispose();
	});

	test("points the empty pane at the view on screen and flags inboxes", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const pane = () =>
			view.container.querySelector("[data-testid='desk-no-selection']");
		const button = (name: string) =>
			[...(pane()?.querySelectorAll("button") ?? [])].find(
				(candidate) => candidate.textContent === name
			);
		expect(pane()?.textContent).toContain("2 conversations need you");
		expect(
			pane()
				?.querySelector("[aria-label^='Next up: ']")
				?.getAttribute("aria-label")
		).toBe("Next up: Design review");
		await click(button("Open next"));
		expect(calls).toEqual(["open:thread-review"]);

		const grace = view.container.querySelector(
			"[data-testid='desk-view-agent:agent-grace']"
		);
		expect(grace?.getAttribute("aria-label")).toContain("1 needs you");
		// Rail counts are always the view's total; an inbox holding threads
		// that need the user sets its label in full weight, with no extra mark.
		const graceLabel = view.container.querySelector(
			"[data-testid='desk-view-agent:agent-grace-needs-you']"
		);
		expect(graceLabel?.textContent).toBe("Grace");
		expect(graceLabel?.className).toContain("font-medium");
		expect(
			view.container.querySelector(
				"[data-testid='desk-view-agent:agent-grace-count']"
			)?.textContent
		).toBe("2");

		await click(
			view.container.querySelector("[data-testid='desk-view-working']")
		);
		expect(rowIds(view.container)).toEqual(["thread-triage"]);
		expect(pane()?.textContent).toContain("2 need you in other views");
		expect(button("Open next")).toBeUndefined();
		await click(button("Go to Needs you"));
		expect(rowIds(view.container)).toEqual(["thread-review", "thread-notes"]);
		await view.dispose();
	});

	test("moves through rows with the keyboard and opens with Enter", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const first = view.container.querySelector(
			"[data-testid='desk-row-thread-review']"
		);
		expect(first?.getAttribute("tabindex")).toBe("0");
		await press(first, "j");
		const second = view.container.querySelector(
			"[data-testid='desk-row-thread-notes']"
		);
		expect(document.activeElement).toBe(second);
		await press(second, "Enter");
		expect(calls).toEqual(["open:thread-notes"]);
		await view.dispose();
	});

	test("shows the host thread view with details that act", async () => {
		const { calls, port } = recordingPort();
		const props = {
			activeThreadId: "thread-review",
			loading: false,
			params: {},
			port,
			snapshot: SNAPSHOT,
			threadView: <div data-testid="host-thread-view">Host</div>,
		};
		const view = await mount(<DeskInterface {...props} />);
		expect(
			view.container.querySelector("[data-testid='host-thread-view']")
		).not.toBeNull();
		const details = view.container.querySelector(
			"[data-testid='desk-details']"
		);
		expect(details?.textContent).toContain("The last run failed");
		expect(details?.textContent).toContain("Design Review");

		await click(
			view.container.querySelector("[data-testid='desk-related-thread-triage']")
		);
		expect(calls).toContain("open:thread-triage");

		await click(
			[...(details?.querySelectorAll("button") ?? [])].find((button) =>
				button.getAttribute("aria-label")?.startsWith("Show team")
			)
		);
		expect(rowIds(view.container)).toEqual(["thread-review"]);

		await click(
			view.container.querySelector("[data-testid='desk-details-toggle']")
		);
		expect(
			view.container.querySelector("[data-testid='desk-details']")
		).toBeNull();

		// "I" brings details back from the list; it never fires from the chat.
		const row = view.container.querySelector(
			"[data-testid='desk-row-thread-review']"
		);
		await press(row, "i");
		expect(
			view.container.querySelector("[data-testid='desk-details']")
		).not.toBeNull();
		const hostView = view.container.querySelector(
			"[data-testid='host-thread-view']"
		);
		await press(hostView, "i");
		expect(
			view.container.querySelector("[data-testid='desk-details']")
		).not.toBeNull();

		await press(hostView, "Escape");
		expect(calls.at(-1)).toBe("close");

		await click(
			view.container.querySelector("[aria-label='Close conversation']")
		);
		expect(calls.filter((call) => call === "close")).toHaveLength(2);
		await view.dispose();
	});

	test("takes the legend's keys before anything in the desk has focus", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		await press(document.body, "j");
		expect(document.activeElement?.getAttribute("data-testid")).toBe(
			"desk-row-thread-review"
		);
		(document.activeElement as HTMLElement | null)?.blur();
		await press(document.body, "j");
		expect(document.activeElement?.getAttribute("data-testid")).toBe(
			"desk-row-thread-notes"
		);
		expect(document.activeElement?.hasAttribute("data-cursor")).toBe(true);
		(document.activeElement as HTMLElement | null)?.blur();
		await press(document.body, "Enter");
		expect(calls).toEqual(["open:thread-notes"]);
		await press(document.body, "c");
		expect(calls.at(-1)).toBe("start:{}");

		// Keys typed into another field on the page are left alone.
		const field = document.createElement("input");
		document.body.append(field);
		field.focus();
		await press(field, "c");
		expect(calls).toHaveLength(2);
		field.remove();
		await view.dispose();
	});

	test("leaves page keys to the host's cover", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the desk it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "j");
		await press(document.body, "Enter");
		await press(document.body, "c");
		expect(document.activeElement).toBe(document.body);
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press(document.body, "c");
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("gives the views rail one tab stop and arrow-key travel", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<DeskInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const rail = view.container.querySelector("[data-testid='desk-rail']");
		const stops = () =>
			[
				...(rail?.querySelectorAll<HTMLButtonElement>(
					"button[data-testid^='desk-view-']"
				) ?? []),
			].filter((button) => button.tabIndex === 0);
		expect(stops().map((button) => button.dataset.testid)).toEqual([
			"desk-view-needs-you",
		]);
		await press(stops()[0], "ArrowDown");
		expect(document.activeElement?.getAttribute("data-testid")).toBe(
			"desk-view-working"
		);
		expect(stops()).toHaveLength(1);
		await press(document.activeElement, "Home");
		expect(document.activeElement?.getAttribute("data-testid")).toBe(
			"desk-view-all"
		);

		await click(
			view.container.querySelector("[data-testid='desk-view-agent:agent-ada']")
		);
		expect(
			view.container.querySelector("[data-testid='desk-no-selection']")
				?.textContent
		).toContain("2 conversations need you in Ada's inbox");
		await view.dispose();
	});
});
