// Inbox interface: keyboard triage, the port calls each shortcut makes, and
// the idle, empty and loading states. happy-dom + createRoot runs real React
// state and handlers; static markup covers what the renderer prints.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxInterface } from "./inbox-interface.tsx";
import { buildInboxModel } from "./inbox-model.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const BASE = Date.now();
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id" | "title">
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
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-audit",
			lastMessage: "Two advisories need a patch release.",
			runState: "failed",
			title: "Audit dependencies",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			pinned: true,
			title: "Release notes",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(600),
		}),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

const ORDER = buildInboxModel(SNAPSHOT).order;

const HOST_VIEW = (
	<div data-testid="host-thread-view">
		<input aria-label="Reply" />
		<div contentEditable suppressContentEditableWarning>
			Draft
		</div>
		<button type="button">Host action</button>
	</div>
);

// ---------------------------------------------------------------------------
// DOM + helpers
// ---------------------------------------------------------------------------

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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

interface InboxProps {
	activeThreadId?: string | null;
	loading?: boolean;
	port?: InterfacePort;
	snapshot?: InterfaceSnapshot;
	threadView?: ReactNode | null;
}

function inbox({
	activeThreadId = null,
	loading = false,
	port = recordingPort().port,
	snapshot = SNAPSHOT,
	threadView = null,
}: InboxProps = {}): ReactElement {
	return (
		<InboxInterface
			activeThreadId={activeThreadId}
			loading={loading}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

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
		row(id: string | undefined) {
			const element = container.querySelector(`[data-inbox-row="${id}"]`);
			if (!(element instanceof HTMLElement)) {
				throw new Error(`No inbox row ${id}`);
			}
			return element;
		},
	};
}

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to send keys to");
	}
	// Keys come from the focused element, as they do in a browser.
	await act(async () => {
		element.focus();
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Inbox interface", () => {
	test("orders rows by urgency and focuses the most urgent one", async () => {
		const view = await mount(inbox());
		expect(ORDER[0]).toBe("thread-audit");
		expect(document.activeElement).toBe(view.row(ORDER[0]));
		expect(view.row(ORDER[0]).getAttribute("tabindex")).toBe("0");
		expect(view.row(ORDER[1]).getAttribute("tabindex")).toBe("-1");
		await view.dispose();
	});

	test("J/K, arrows, Home and End move a roving cursor", async () => {
		const view = await mount(inbox());
		const last = ORDER.at(-1);
		await press(view.row(ORDER[0]), "j");
		expect(document.activeElement).toBe(view.row(ORDER[1]));
		await press(view.row(ORDER[1]), "ArrowDown");
		expect(document.activeElement).toBe(view.row(ORDER[2]));
		await press(view.row(ORDER[2]), "k");
		expect(document.activeElement).toBe(view.row(ORDER[1]));
		await press(view.row(ORDER[1]), "End");
		expect(document.activeElement).toBe(view.row(last));
		expect(view.row(last).getAttribute("tabindex")).toBe("0");
		// The cursor stops at the ends instead of wrapping.
		await press(view.row(last), "j");
		expect(document.activeElement).toBe(view.row(last));
		await press(view.row(last), "Home");
		expect(document.activeElement).toBe(view.row(ORDER[0]));
		await press(view.row(ORDER[0]), "ArrowUp");
		expect(document.activeElement).toBe(view.row(ORDER[0]));
		await view.dispose();
	});

	test("Enter, O and Space open the focused row", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(inbox({ port }));
		await press(view.row(ORDER[0]), "Enter");
		await press(view.row(ORDER[1]), "o");
		await press(view.row(ORDER[2]), " ");
		expect(calls).toEqual([
			`open:${ORDER[0]}`,
			`open:${ORDER[1]}`,
			`open:${ORDER[2]}`,
		]);
		await click(view.row(ORDER[3]));
		expect(calls.at(-1)).toBe(`open:${ORDER[3]}`);
		await view.dispose();
	});

	test("Esc closes the thread and focus returns to the cursor row", async () => {
		const { calls, port } = recordingPort();
		const open = ORDER[1];
		const view = await mount(
			inbox({ activeThreadId: open, port, threadView: HOST_VIEW })
		);
		expect(view.row(open).getAttribute("aria-selected")).toBe("true");
		view.row(open).focus();
		await press(view.row(open), "Escape");
		expect(calls).toEqual(["close"]);
		// Focus sits in the host chat when it unmounts; the row takes it back.
		const hostButton = view.container.querySelector("[data-inbox-host] button");
		if (hostButton instanceof HTMLElement) {
			hostButton.focus();
		}
		expect(document.activeElement).toBe(hostButton);
		await view.rerender(inbox({ port }));
		expect(document.activeElement).toBe(view.row(open));
		await view.dispose();
	});

	test("C starts a blank thread, but not from inside the host chat", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			inbox({ activeThreadId: ORDER[0], port, threadView: HOST_VIEW })
		);
		await press(view.row(ORDER[0]), "c");
		expect(calls).toEqual(["start:{}"]);
		const hostButton = view.container.querySelector("[data-inbox-host] button");
		await press(hostButton, "c");
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("J/K with a thread open opens the neighbour", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			inbox({ activeThreadId: ORDER[1], port, threadView: HOST_VIEW })
		);
		const detail = view.container.querySelector('[data-testid="inbox-detail"]');
		await press(detail, "j");
		expect(calls).toEqual([`open:${ORDER[2]}`]);
		await view.rerender(
			inbox({ activeThreadId: ORDER[2], port, threadView: HOST_VIEW })
		);
		await press(detail, "k");
		expect(calls.at(-1)).toBe(`open:${ORDER[1]}`);
		await view.dispose();
	});

	test("letter keys are ignored while typing", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			inbox({ activeThreadId: ORDER[0], port, threadView: HOST_VIEW })
		);
		const input = view.container.querySelector('input[aria-label="Reply"]');
		const editable = view.container.querySelector("[contenteditable]");
		for (const key of ["j", "k", "c", "o", "Escape"]) {
			await press(input, key);
			await press(editable, key);
		}
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("prev/next header buttons disable at the ends of the list", async () => {
		const { calls, port } = recordingPort();
		const first = await mount(
			inbox({ activeThreadId: ORDER[0], port, threadView: HOST_VIEW })
		);
		const button = (name: string) =>
			first.container.querySelector(`button[aria-label="${name}"]`);
		expect(button("Previous thread")?.hasAttribute("disabled")).toBe(true);
		expect(button("Next thread")?.hasAttribute("disabled")).toBe(false);
		await click(button("Next thread"));
		expect(calls).toEqual([`open:${ORDER[1]}`]);
		await first.rerender(
			inbox({ activeThreadId: ORDER.at(-1), port, threadView: HOST_VIEW })
		);
		expect(button("Previous thread")?.hasAttribute("disabled")).toBe(false);
		expect(button("Next thread")?.hasAttribute("disabled")).toBe(true);
		await first.dispose();
	});

	test("row names are stable: title, status, actor, pinned, age", () => {
		const html = renderToStaticMarkup(inbox());
		expect(html).toContain(
			'aria-label="Audit dependencies, Needs attention, Ada, updated 30m ago"'
		);
		expect(html).toContain(
			'aria-label="Release notes, Your turn, Ada, pinned, updated 2h ago"'
		);
	});

	test("idle pane previews the most urgent thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(inbox({ port }));
		const idle = view.container.querySelector('[data-testid="inbox-idle"]');
		expect(idle?.getAttribute("aria-label")).toBe(
			"Preview: Audit dependencies"
		);
		expect(idle?.textContent).toContain("Two advisories need a patch release.");
		expect(
			idle?.querySelector('[aria-label="Details"] dl')?.textContent
		).toContain("Agents");
		const next = idle?.querySelector("button");
		expect(next?.getAttribute("aria-label")).toBe(
			"Open Audit dependencies, Needs attention, Ada"
		);
		await click(next);
		expect(calls).toEqual(["open:thread-audit"]);
		await view.dispose();
	});

	test("idle preview follows the keyboard cursor", async () => {
		const view = await mount(inbox());
		await press(view.row(ORDER[0]), "j");
		const idle = view.container.querySelector('[data-testid="inbox-idle"]');
		expect(idle?.getAttribute("aria-label")).toBe("Preview: Release notes");
		expect(idle?.textContent).toContain("Draft is ready for review.");
		await view.dispose();
	});

	test("empty inbox says so and offers a new thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(inbox({ port, snapshot: EMPTY }));
		expect(view.container.textContent).toContain("No threads yet");
		expect(view.container.querySelector('[role="listbox"]')).toBeNull();
		const idle = view.container.querySelector('[data-testid="inbox-idle"]');
		await click(idle?.querySelector("button"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("first load shows a row-shaped skeleton, not an empty claim", () => {
		const html = renderToStaticMarkup(
			inbox({ loading: true, snapshot: EMPTY })
		);
		expect(html).toContain('data-testid="inbox-skeleton"');
		expect(html).toContain("Loading inbox");
		expect(html).not.toContain("No threads yet");
		expect(html).not.toContain("need you");
	});
});
