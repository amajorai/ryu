// Graph interface: render states and the interactions that reach the port.
// happy-dom with createRoot runs real React state and handlers; static
// markup covers the loading state.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphInterface } from "./graph-interface.tsx";

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
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Docs Crew",
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
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

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

type PortCall =
	| { kind: "close" }
	| { id: string; kind: "open" }
	| { input: Parameters<InterfacePort["startThread"]>[0]; kind: "start" };

function recordingPort(onClose?: () => void) {
	const calls: PortCall[] = [];
	const port: InterfacePort = {
		closeThread: () => {
			calls.push({ kind: "close" });
			onClose?.();
		},
		openThread: (id) => calls.push({ id, kind: "open" }),
		startThread: (input) => calls.push({ input, kind: "start" }),
	};
	return { calls, port };
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
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function pressEscape() {
	await act(async () => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "Escape",
			})
		);
	});
}

function button(
	scope: ParentNode | null | undefined,
	name: string
): HTMLButtonElement | undefined {
	return [...(scope?.querySelectorAll("button") ?? [])].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === name ||
			candidate.textContent?.trim() === name
	);
}

/** Type into a controlled textarea the way React's onChange observes it. */
async function typeInto(field: Element | null | undefined, value: string) {
	if (!(field instanceof HTMLTextAreaElement)) {
		throw new Error("Expected a textarea");
	}
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

const nodePanel = (container: ParentNode) =>
	container.querySelector("[data-testid='graph-node-panel']");
const threadPanel = (container: ParentNode) =>
	container.querySelector("[data-testid='graph-thread-panel']");

/** A host that shows a thread view while one is open, like the desktop app. */
function Host({ calls }: { calls: PortCall[] }) {
	const [openId, setOpenId] = useState<string | null>("thread-triage");
	const port: InterfacePort = {
		closeThread: () => {
			calls.push({ kind: "close" });
			setOpenId(null);
		},
		openThread: (id) => {
			calls.push({ id, kind: "open" });
			setOpenId(id);
		},
		startThread: (input) => calls.push({ input, kind: "start" }),
	};
	return (
		<GraphInterface
			activeThreadId={openId}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={
				openId ? <div data-testid="host-thread-view">{openId}</div> : null
			}
		/>
	);
}

describe("GraphInterface", () => {
	test("shows a loading skeleton while the first snapshot loads", () => {
		const html = renderToStaticMarkup(
			<GraphInterface
				activeThreadId={null}
				loading
				params={{}}
				port={recordingPort().port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-testid="interface-graph"');
	});

	test("the empty state starts a new thread without a prompt", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GraphInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(view.container.textContent).toContain("No one on the map yet");
		await click(button(view.container, "New thread"));
		expect(calls).toEqual([{ input: {}, kind: "start" }]);
		await view.dispose();
	});

	test("picking a node opens its panel with that node's threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GraphInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(nodePanel(view.container)).toBeNull();
		const ada = view.container.querySelector(
			"[data-graph-node='agent:agent-ada']"
		);
		expect(ada?.getAttribute("aria-label")).toBe(
			"Ada: 1 thread, your turn on 1 thread"
		);
		await click(ada);
		const panel = nodePanel(view.container);
		expect(panel?.getAttribute("aria-label")).toBe("Ada details");
		expect(panel?.textContent).toContain("Release notes");
		expect(panel?.textContent).toContain("Your turn");
		expect(panel?.textContent).not.toContain("Crash triage");
		const row = [...(panel?.querySelectorAll("button") ?? [])].find(
			(candidate) => candidate.textContent?.startsWith("Release notes")
		);
		await click(row);
		expect(calls).toEqual([{ id: "thread-notes", kind: "open" }]);
		await view.dispose();
	});

	test("a keyboard pick marks the node and dims the rest like a pointer pick", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<GraphInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const node = (id: string) =>
			view.container.querySelector<HTMLButtonElement>(
				`[data-graph-node='${id}']`
			);
		const dimmed = (id: string) =>
			Boolean(node(id)?.querySelector(".grayscale"));
		expect(dimmed("agent:agent-grace")).toBe(false);
		// Enter on a focused button: a click whose `detail` is 0.
		await act(async () => {
			const ada = node("agent:agent-ada");
			ada?.focus();
			ada?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })
			);
		});
		expect(node("agent:agent-ada")?.getAttribute("aria-pressed")).toBe("true");
		expect(
			node("agent:agent-ada")?.querySelector(".ring-primary")
		).not.toBeNull();
		expect(dimmed("agent:agent-ada")).toBe(false);
		// Grace shares no thread with Ada, so she steps back.
		expect(node("agent:agent-grace")?.getAttribute("aria-pressed")).toBe(
			"false"
		);
		expect(dimmed("agent:agent-grace")).toBe(true);
		// The team Ada belongs to stays lit.
		expect(
			node("team:team-docs")?.className.includes("text-muted-foreground")
		).toBe(false);
		expect(nodePanel(view.container)?.getAttribute("aria-label")).toBe(
			"Ada details"
		);
		await view.dispose();
	});

	test("Escape closes the open thread, then the node panel", async () => {
		const calls: PortCall[] = [];
		const view = await mount(<Host calls={calls} />);
		expect(threadPanel(view.container)).not.toBeNull();
		expect(
			view.container.querySelector("[data-testid='host-thread-view']")
		).not.toBeNull();

		await pressEscape();
		expect(calls).toEqual([{ kind: "close" }]);
		expect(threadPanel(view.container)).toBeNull();
		// Back from a thread lands on the agent it belongs to.
		expect(nodePanel(view.container)?.getAttribute("aria-label")).toBe(
			"Grace details"
		);

		await pressEscape();
		expect(nodePanel(view.container)).toBeNull();
		expect(calls).toEqual([{ kind: "close" }]);
		await view.dispose();
	});

	test("the composer starts a thread only when a typed prompt is submitted", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GraphInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			view.container.querySelector("[data-graph-node='agent:agent-grace']")
		);
		const panel = nodePanel(view.container);
		const field = panel?.querySelector("textarea");
		const send = button(panel, "Start thread");
		expect(send?.disabled).toBe(true);

		await typeInto(field, "  Check the nightly crash  ");
		expect(calls).toEqual([]);

		const form = panel?.querySelector("form");
		if (!form) {
			throw new Error("Expected the composer form");
		}
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([
			{
				input: { agentId: "agent-grace", prompt: "Check the nightly crash" },
				kind: "start",
			},
		]);
		await view.dispose();
	});
});
