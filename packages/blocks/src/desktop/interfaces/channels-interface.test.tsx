import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelsInterface } from "./channels-interface.tsx";

const MINUTE = 60_000;
const ago = (minutes: number) =>
	new Date(Date.now() - minutes * MINUTE).toISOString();

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
			description: "Builds pages",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
	],
	groups: [
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada"],
			name: "Docs Crew",
		},
		{
			id: "proj-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Site Refresh",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-hero",
			lastMessage: "Swapping the hero image now.",
			messageCount: 4,
			projectId: "proj-site",
			running: true,
			title: "Rebuild the hero",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			pinned: true,
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Shortened the intro.",
			runState: "failed",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const PARAMS = { groupBy: "project" } as const;
const THREAD_VIEW = <div data-testid="host-thread-view">Host chat surface</div>;

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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
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

/**
 * Type into a controlled field the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function byLabel<T extends HTMLElement>(
	root: ParentNode,
	selector: string,
	label: string
): T {
	const match = [...root.querySelectorAll<T>(selector)].find(
		(element) => element.getAttribute("aria-label") === label
	);
	if (!match) {
		throw new Error(`No ${selector} labeled "${label}"`);
	}
	return match;
}

function channelRow(container: HTMLElement, label: string) {
	const row = [
		...container.querySelectorAll<HTMLButtonElement>("[data-channel-row]"),
	].find((candidate) => candidate.textContent?.includes(label));
	if (!row) {
		throw new Error(`No channel row "${label}"`);
	}
	return row;
}

function tab(container: HTMLElement, name: string) {
	const match = [
		...container.querySelectorAll<HTMLElement>('[role="tab"]'),
	].find((candidate) => candidate.textContent?.includes(name));
	if (!match) {
		throw new Error(`No tab "${name}"`);
	}
	return match;
}

function render(
	port: InterfacePort,
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		snapshot: InterfaceSnapshot;
		threadView: ReactElement | null;
	}> = {}
) {
	return (
		<ChannelsInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={PARAMS}
			port={port}
			snapshot={overrides.snapshot ?? SNAPSHOT}
			threadView={overrides.threadView ?? null}
		/>
	);
}

describe("ChannelsInterface", () => {
	test("lists #channels and direct messages, newest channel open", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(render(port));

		expect(html).toContain('data-testid="interface-channels"');
		expect(html).toContain('aria-label="Channels"');
		expect(html).toContain("Direct messages");
		expect(html).toContain("site-refresh");
		expect(html).toContain("docs-crew");
		expect(html).toContain("general");
		// The channel name sits in its own no-wrap span.
		expect(html).toMatch(/Welcome to <span[^>]*>#site-refresh<\/span>/);
		expect(html).toContain("Grace is in this channel.");
		expect(html).toContain("Rebuild the hero");
		expect(html).toContain("3 replies");
		// No count badge on the channel you are in; work in flight is
		// announced, not counted like mentions.
		expect(html).toContain(", 1 working");
		expect(html).not.toContain("animate-ping");
		expect(html).toContain('role="feed"');
		expect(html).not.toContain('role="toolbar"');
	});

	test("switching channels closes the open thread", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			await click(channelRow(container, "docs-crew"));

			expect(calls).toEqual(["close"]);
			expect(
				channelRow(container, "docs-crew").getAttribute("aria-current")
			).toBe("page");
			expect(container.textContent).toContain("Welcome to #docs-crew");
		} finally {
			await dispose();
		}
	});

	test("the composer starts a thread for the channel, never on an empty draft", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			const send = byLabel<HTMLButtonElement>(container, "button", "Send now");
			expect(send.disabled).toBe(true);
			await act(async () => send.form?.requestSubmit());
			expect(calls).toEqual([]);

			const field = byLabel<HTMLTextAreaElement>(
				container,
				"textarea",
				"Message site-refresh"
			);
			await typeInto(field, "   ");
			await act(async () => field.form?.requestSubmit());
			expect(calls).toEqual([]);

			await typeInto(field, "  Tighten the footer  ");
			await act(async () => field.form?.requestSubmit());
			expect(calls).toEqual([
				`start:${JSON.stringify({
					agentId: "agent-grace",
					projectId: "proj-site",
					prompt: "Tighten the footer",
				})}`,
			]);
			expect(field.value).toBe("");

			// A team channel sends as the team.
			await click(channelRow(container, "docs-crew"));
			const teamField = byLabel<HTMLTextAreaElement>(
				container,
				"textarea",
				"Message docs-crew"
			);
			await typeInto(teamField, "Ship the notes");
			await act(async () => teamField.form?.requestSubmit());
			expect(calls.at(-1)).toBe(
				`start:${JSON.stringify({
					agentId: "agent-ada",
					prompt: "Ship the notes",
					teamId: "team-docs",
				})}`
			);
		} finally {
			await dispose();
		}
	});

	test("the Pinned tab lists pinned threads or says nothing is pinned", async () => {
		const { port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			await click(tab(container, "Pinned"));
			expect(container.textContent).toContain(
				"Nothing pinned in #site-refresh"
			);

			await click(channelRow(container, "docs-crew"));
			await click(tab(container, "Pinned"));
			expect(container.textContent).toContain("Pinned by you");
			expect(container.textContent).toContain("Release notes");
		} finally {
			await dispose();
		}
	});

	test("search narrows the open channel and points at other matches", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			const search = byLabel<HTMLInputElement>(
				container,
				"input",
				"Search Ryu"
			);

			await typeInto(search, "hero");
			expect(container.textContent).toContain(
				"1 message in #site-refresh matches"
			);

			await typeInto(search, "release");
			expect(container.textContent).toContain(
				"No messages in #site-refresh match"
			);
			const hits = byLabel<HTMLElement>(
				container,
				"ul",
				"Channels with matches"
			);
			expect(hits.textContent).toContain("docs-crew");
			await click(hits.querySelector("button"));
			expect(calls).toEqual(["close"]);
			expect(container.textContent).toContain(
				"1 message in #docs-crew matches"
			);

			await typeInto(search, "zzzz");
			expect(container.textContent).toContain(
				"Nothing in any channel matches."
			);
			await click(byLabel(container, "button", "Clear search"));
			expect(search.value).toBe("");
		} finally {
			await dispose();
		}
	});

	test("an open thread shows the host thread view in the Thread panel", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(
			render(port, { activeThreadId: "thread-hero", threadView: THREAD_VIEW })
		);
		try {
			const panel = byLabel<HTMLElement>(container, "aside", "Thread");
			expect(
				panel.querySelector('[data-testid="host-thread-view"]')
			).not.toBeNull();
			expect(panel.textContent).toContain("site-refresh");

			await click(byLabel(panel, "button", "Close thread"));
			expect(calls).toEqual(["close"]);
		} finally {
			await dispose();
		}
	});

	test("the thread bar and the hover action open the thread", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			await click(byLabel(container, "button", "Reply in thread"));
			const bar = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((button) =>
				button.getAttribute("aria-label")?.startsWith("3 replies")
			);
			await click(bar);
			expect(calls).toEqual(["open:thread-hero", "open:thread-hero"]);
		} finally {
			await dispose();
		}
	});

	test("Copy message copies the visible title and latest text", async () => {
		const { port } = recordingPort();
		const written: string[] = [];
		const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (text: string) => {
					written.push(text);
					return Promise.resolve();
				},
			},
		});
		const { container, dispose } = await mount(render(port));
		try {
			const message = [...container.querySelectorAll("article")].find(
				(article) =>
					article.getAttribute("aria-label")?.endsWith("Rebuild the hero")
			);
			if (!message) {
				throw new Error("No Rebuild the hero message");
			}
			await click(byLabel(message, "button", "Copy message"));
			expect(written).toEqual([
				"Rebuild the hero\nSwapping the hero image now.",
			]);
		} finally {
			await dispose();
			if (original) {
				Object.defineProperty(navigator, "clipboard", original);
			}
		}
	});

	test("a failed run says so on its thread bar", async () => {
		const { port } = recordingPort();
		const { container, dispose } = await mount(render(port));
		try {
			await click(channelRow(container, "Ada"));
			expect(container.textContent).toContain(
				"This conversation is just between you and"
			);
			expect(container.textContent).toContain("Run failed");
		} finally {
			await dispose();
		}
	});

	test("loading shows skeletons shaped like the real list and pane", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			render(port, { loading: true, snapshot: EMPTY_SNAPSHOT })
		);

		expect(html).toContain('aria-label="Loading channel"');
		expect(html).toContain("Loading channels");
		expect(html).toContain("animate-skeleton");
		expect(html).not.toContain("No agents yet");
		expect(html).not.toContain("Loading…");
	});

	test("no agents: one quiet sidebar line and a New message action", async () => {
		const { calls, port } = recordingPort();
		const html = renderToStaticMarkup(
			render(port, { snapshot: EMPTY_SNAPSHOT })
		);
		expect(html).toContain("No agents yet");
		expect(html).toContain("No channels yet.");
		expect(html).not.toContain("Nothing here yet");

		const { container, dispose } = await mount(
			render(port, { snapshot: EMPTY_SNAPSHOT })
		);
		try {
			const action = [...container.querySelectorAll("button")].find(
				(button) =>
					button.textContent?.includes("New message") &&
					!button.hasAttribute("aria-label")
			);
			await click(action);
			expect(calls).toEqual(["start:{}"]);
		} finally {
			await dispose();
		}
	});
});
