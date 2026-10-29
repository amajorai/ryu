import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalInterface } from "./terminal-interface.tsx";
import { listThreads } from "./terminal-model.ts";
import {
	BANNER_ROWS,
	groupTerminalBlocks,
	type TerminalEntry,
	terminalBlockText,
	textRow,
} from "./terminal-output.tsx";

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

const UPDATED = "2026-10-12T12:00:00Z";

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
		updatedAt: UPDATED,
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Research",
			id: "agent-atlas",
			name: "Atlas",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Ships things",
			id: "agent-forge",
			name: "Forge",
			status: "working",
		},
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-atlas"],
			id: "thread-question",
			lastMessage: "Which option?",
			title: "Pick an option",
		}),
		thread({
			agentIds: ["agent-forge"],
			id: "thread-build",
			running: true,
			title: "Build the hero",
		}),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

function render(loading: boolean, threadView: string | null = null): string {
	return renderToStaticMarkup(
		<TerminalInterface
			activeThreadId={threadView ? "t-1" : null}
			loading={loading}
			params={{}}
			port={NOOP_PORT}
			snapshot={EMPTY}
			threadView={threadView}
		/>
	);
}

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
	| { kind: "open"; threadId: string }
	| { kind: "start"; request: Parameters<InterfacePort["startThread"]>[0] };

function spyPort() {
	const calls: PortCall[] = [];
	const port: InterfacePort = {
		closeThread: () => {
			calls.push({ kind: "close" });
		},
		openThread: (threadId) => {
			calls.push({ kind: "open", threadId });
		},
		startThread: (request) => {
			calls.push({ kind: "start", request });
		},
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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

function promptInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector("input");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected the terminal prompt");
	}
	return input;
}

/** Type a command into the prompt and press Enter. */
async function run(container: HTMLElement, command: string) {
	const input = promptInput(container);
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	// React watches the focused field's keyup as well as `input`, so send both.
	await act(async () => {
		input.focus();
		setValue?.call(input, command);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
	await act(async () => {
		input.form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
}

async function pressEscape(container: HTMLElement) {
	const input = promptInput(container);
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
}

function terminal(port: InterfacePort, threadView: string | null = null) {
	return (
		<TerminalInterface
			activeThreadId={threadView ? "thread-build" : null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={threadView}
		/>
	);
}

describe("TerminalInterface", () => {
	test("renders a labelled prompt and a polite log", () => {
		const html = render(false);
		expect(html).toContain('data-testid="interface-terminal"');
		expect(html).toContain('role="log"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Terminal command");
		expect(html).toContain("0 agents");
		expect(html).toContain("0 threads");
	});

	test("prints a plain empty state when there are no threads or agents", async () => {
		const html = render(false);
		expect(html).toContain("no threads yet");
		expect(html).not.toContain("<table");

		const view = await mount(
			<TerminalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		await run(view.container, "agents");
		expect(view.container.textContent).toContain("no agents yet");
		await run(view.container, "ls");
		const text = view.container.textContent ?? "";
		expect(text.split("no threads yet").length - 1).toBe(2);
		await view.dispose();
	});

	test("shows loading instead of zero counts while the snapshot settles", () => {
		const html = render(true);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("loading agents and threads");
		expect(html).not.toContain("0 working");
		expect(html).not.toContain("need you");
	});

	test("shows the host thread view beside the scrollback", () => {
		const html = render(false, "HOST-THREAD-VIEW");
		expect(html).toContain("HOST-THREAD-VIEW");
		expect(html).toContain('aria-label="Close thread"');
	});

	test("ls then open <n> opens the numbered thread through the port", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await run(view.container, "ls");
		const blocks = view.container.querySelectorAll('[data-block="command"]');
		expect(blocks.length).toBe(1);
		expect(blocks[0]?.querySelector("table")).not.toBeNull();

		await run(view.container, "open 1");
		const first = listThreads(SNAPSHOT, "all")[0]?.threadId;
		expect(calls).toEqual([{ kind: "open", threadId: first ?? "" }]);
		expect(view.container.textContent).toContain("opened #1");
		await view.dispose();
	});

	test("the banner points at its rows, not at numbers a filtered ls reuses", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		const banner = view.container.querySelector('[data-block="banner"]');
		expect(banner?.textContent).toContain("click a row to open");
		expect(banner?.textContent).not.toContain("open <n>");

		await run(view.container, "ls working");
		const row = [...(banner?.querySelectorAll("button") ?? [])].find((node) =>
			node.getAttribute("aria-label")?.endsWith(": Pick an option")
		);
		await act(async () => row?.click());
		expect(calls).toEqual([{ kind: "open", threadId: "thread-question" }]);
		await view.dispose();
	});

	test("a capped banner points at ls, which lists every thread that needs you", async () => {
		const crowded: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				...Array.from({ length: 4 }, (_, index) =>
					thread({ agentIds: ["agent-atlas"], id: `thread-reply-${index}` })
				),
				...Array.from({ length: 3 }, (_, index) =>
					thread({
						agentIds: ["agent-forge"],
						id: `thread-failed-${index}`,
						runState: "failed",
					})
				),
			],
		};
		const view = await mount(
			<TerminalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={NOOP_PORT}
				snapshot={crowded}
				threadView={null}
			/>
		);
		const banner = view.container.querySelector('[data-block="banner"]');
		expect(banner?.textContent).toContain(`+${7 - BANNER_ROWS} more`);
		expect(banner?.textContent).toContain("ls for all");
		expect(banner?.textContent).not.toContain("ls your-turn");
		await run(view.container, "ls");
		const listed = view.container.querySelector('[data-block="command"]');
		for (const item of crowded.threads) {
			expect(listed?.textContent).toContain(item.title);
		}
		await view.dispose();
	});

	test("clicking a listed title opens that thread", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await run(view.container, "ls");
		const title = [...view.container.querySelectorAll("button")].find((node) =>
			node.getAttribute("aria-label")?.endsWith(": Pick an option")
		);
		await act(async () => title?.click());
		expect(calls).toEqual([{ kind: "open", threadId: "thread-question" }]);
		await view.dispose();
	});

	test("@agent message starts a thread with the typed prompt", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await run(view.container, "@atlas hi there");
		expect(calls).toEqual([
			{
				kind: "start",
				request: { agentId: "agent-atlas", prompt: "hi there" },
			},
		]);
		await view.dispose();
	});

	test("a bare new never starts a thread", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await run(view.container, "new");
		await run(view.container, "new   ");
		await run(view.container, "@atlas");
		expect(calls).toEqual([]);
		expect(view.container.textContent).toContain("new: missing message");
		await view.dispose();
	});

	test("unknown commands print an error and a hint on separate lines", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await run(view.container, "xyz");
		const lines = [
			...view.container.querySelectorAll('[data-block="command"] p'),
		].map((node) => node.textContent);
		expect(lines).toContain("ryu: command not found: xyz");
		expect(lines).toContain("try help");
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("Escape closes the open thread and is a no-op otherwise", async () => {
		const { calls, port } = spyPort();
		const view = await mount(terminal(port));
		await pressEscape(view.container);
		expect(calls).toEqual([]);

		await view.rerender(terminal(port, "HOST-THREAD-VIEW"));
		expect(view.container.textContent).toContain("HOST-THREAD-VIEW");
		await pressEscape(view.container);
		expect(calls).toEqual([{ kind: "close" }]);
		await view.dispose();
	});

	test("the footer tints only the attention count", async () => {
		const view = await mount(terminal(NOOP_PORT));
		const footer = view.container.querySelector("footer");
		expect(footer?.textContent).toContain("1 working");
		expect(footer?.textContent).not.toContain("(");
		expect(footer?.querySelector(".text-primary")).toBeNull();
		await view.dispose();
	});

	test("groups a command with its output and notices into their own blocks", () => {
		const entries: TerminalEntry[] = [
			{ id: 0, kind: "banner" },
			{ id: 1, kind: "command", prompt: "~", text: "help" },
			{ id: 2, kind: "help" },
			{ id: 3, kind: "line", segments: [{ text: "a" }], standalone: true },
			{ id: 4, kind: "line", segments: [{ text: "b" }], standalone: true },
			{ id: 5, kind: "command", prompt: "~", text: "xyz" },
			{ id: 6, kind: "line", segments: [{ text: "err" }] },
			{ id: 7, kind: "line", segments: [{ text: "hint" }] },
		];
		expect(
			groupTerminalBlocks(entries).map((block) => [
				block.kind,
				block.entries.map((entry) => entry.id),
			])
		).toEqual([
			["banner", [0]],
			["command", [1, 2]],
			["notice", [3, 4]],
			["command", [5, 6, 7]],
		]);
	});

	test("prints open errors tersely with a muted hint", async () => {
		const view = await mount(terminal(NOOP_PORT));
		await run(view.container, "open 99");
		const text = view.container.textContent ?? "";
		expect(text).toContain("open: no thread #99");
		expect(text).toContain("ls to refresh");
		expect(text).not.toContain("Run ls");
		await view.dispose();
	});

	test("help lists commands and every key binding the footer advertises", async () => {
		const view = await mount(terminal(NOOP_PORT));
		await run(view.container, "help");
		const text = view.container.textContent ?? "";
		for (const key of ["↑↓", "tab", "ctrl-l", "ctrl-u", "esc"]) {
			expect(text).toContain(key);
		}
		expect(view.container.querySelector("caption")?.textContent).toBeTruthy();
		await view.dispose();
	});

	test("each block offers a labelled copy action", async () => {
		const view = await mount(terminal(NOOP_PORT));
		await run(view.container, "ls");
		const blocks = view.container.querySelectorAll("[data-block]");
		for (const block of blocks) {
			expect(
				block.querySelector('button[aria-label="Copy output"]')
			).not.toBeNull();
		}
		await view.dispose();
	});

	test("copies a block as aligned plain text", () => {
		const [block] = groupTerminalBlocks([
			{ id: 1, kind: "command", prompt: "~", text: "ls" },
			{
				filter: "all",
				id: 2,
				kind: "threads",
				now: Date.now(),
				rows: listThreads(SNAPSHOT, "all"),
			},
		]);
		if (!block) {
			throw new Error("Expected a block");
		}
		const text = terminalBlockText(block, { needsYou: [], now: Date.now() });
		const [header] = text.split("\n");
		expect(header).toBe("#    status       agent         age  title");
		expect(text.split("\n")).toHaveLength(SNAPSHOT.threads.length + 1);
	});

	test("copied columns keep a space even when a cell overflows its width", () => {
		expect(textRow(["#", "status", "title"], [5, 13])).toBe(
			"#    status       title"
		);
		expect(
			textRow(["12", "averyverylonghandle", "2h", "Fix it"], [5, 13, 5])
		).toBe("12   averyverylonghandle 2h   Fix it");
		expect(textRow(["exactly5", "x"], [8])).toBe("exactly5 x");
	});
});
