import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelsInterface } from "./channels-interface.tsx";
import { FeedInterface } from "./feed-interface.tsx";
import { World2dInterface } from "./world-2d-interface.tsx";

const NOW = new Date().toISOString();

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
		{
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			lastMessageRole: "assistant",
			messageCount: 4,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: NOW,
		},
		{
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: true,
			teamId: "team-design",
			title: "Crash triage",
			updatedAt: NOW,
		},
	],
	version: 1,
};

const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

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

/** Mount a renderer into the DOM so interactions run real React state. */
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

/**
 * Type into a controlled input the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(target: HTMLElement, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

/** The element matching `selector` whose aria-label is exactly `name`. */
function labelled(root: ParentNode, selector: string, name: string) {
	const match = [...root.querySelectorAll<HTMLElement>(selector)].find(
		(element) => element.getAttribute("aria-label") === name
	);
	if (!match) {
		throw new Error(`No ${selector} labeled "${name}"`);
	}
	return match;
}

/** The text field whose <label> reads `name`. */
function fieldLabelled(root: ParentNode, name: string) {
	const label = [...root.querySelectorAll("label")].find(
		(element) => element.textContent?.includes(name) ?? false
	);
	const field = label?.htmlFor
		? root.querySelector(`[id="${label.htmlFor}"]`)
		: null;
	if (
		!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)
	) {
		throw new Error(`No field labeled "${name}"`);
	}
	return field;
}

function timelinePostIds(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll<HTMLButtonElement>("button[data-feed-post]"),
	].map((button) => button.dataset.feedPost ?? "");
}

describe("ChannelsInterface", () => {
	test("lists team #channels and agent direct messages", () => {
		const html = renderToStaticMarkup(
			<ChannelsInterface
				activeThreadId={null}
				loading={false}
				params={{ groupBy: "agent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);

		expect(html).toContain('aria-label="Channels"');
		expect(html).toContain("Direct messages");
		expect(html).toContain("design-review");
		expect(html).toContain("Ada");
		expect(html).toContain("Grace");
		expect(html).toContain("New thread");
	});

	test("shows the host thread view for the open thread", () => {
		const html = renderToStaticMarkup(
			<ChannelsInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{ groupBy: "agent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={THREAD_VIEW}
			/>
		);

		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).not.toContain("Messages here start a new thread.");
	});

	test("renders empty and loading states without agents", () => {
		const empty = renderToStaticMarkup(
			<ChannelsInterface
				activeThreadId={null}
				loading={false}
				params={{ groupBy: "agent" }}
				port={NOOP_PORT}
				snapshot={EMPTY_SNAPSHOT}
				threadView={null}
			/>
		);
		const loading = renderToStaticMarkup(
			<ChannelsInterface
				activeThreadId={null}
				loading
				params={{ groupBy: "agent" }}
				port={NOOP_PORT}
				snapshot={EMPTY_SNAPSHOT}
				threadView={null}
			/>
		);

		expect(empty).toContain("No agents yet");
		expect(empty).toContain("No channels yet.");
		expect(loading).toContain("Loading channels");
		expect(loading).toContain("animate-skeleton");
	});
	test("collapsing a sidebar section keeps only live and current channels", async () => {
		const { container, dispose } = await mount(
			<ChannelsInterface
				activeThreadId={null}
				loading={false}
				params={{ groupBy: "agent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			const sidebar = container.querySelector('nav[aria-label="Channels"]');
			const toggle = [
				...(sidebar?.querySelectorAll<HTMLButtonElement>(
					"button[aria-expanded]"
				) ?? []),
			].find((button) => button.textContent?.includes("Direct messages"));
			const rowLabels = () =>
				[...(sidebar?.querySelectorAll("[data-channel-row]") ?? [])].map(
					(row) => row.textContent ?? ""
				);

			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			expect(rowLabels().some((label) => label.includes("Ada"))).toBe(true);

			await click(toggle);

			expect(toggle?.getAttribute("aria-expanded")).toBe("false");
			// Neither DM is open or running, so both fold away; the running
			// #design-review channel in the other section stays.
			expect(rowLabels().some((label) => label.includes("Ada"))).toBe(false);
			expect(rowLabels().some((label) => label.includes("Grace"))).toBe(false);
			expect(rowLabels().some((label) => label.includes("design-review"))).toBe(
				true
			);

			await click(toggle);

			expect(rowLabels().some((label) => label.includes("Ada"))).toBe(true);
		} finally {
			await dispose();
		}
	});
});

describe("FeedInterface", () => {
	test("renders every thread as a post with its reply count", () => {
		const html = renderToStaticMarkup(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);

		expect(html).toContain('aria-label="Feed"');
		expect(html).toContain("Release notes");
		expect(html).toContain("Crash triage");
		expect(html).toContain("Draft is ready for review.");
		expect(html).toContain("@ada");
		// Four messages: the opening post plus three replies.
		expect(html).toContain('3<span class="sr-only"> replies</span>');
		expect(html).toContain('1<span class="sr-only"> reply</span>');
		expect(html).toContain("Post");
		expect(html).toContain("New post");
		expect(html).not.toContain('aria-label="Post and replies"');
	});

	test("opens the host thread view as the reply chain", () => {
		const html = renderToStaticMarkup(
			<FeedInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={THREAD_VIEW}
			/>
		);

		expect(html).toContain('aria-label="Post and replies"');
		expect(html).toContain('aria-label="Back to feed"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("renders an empty feed", () => {
		const html = renderToStaticMarkup(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={EMPTY_SNAPSHOT}
				threadView={null}
			/>
		);

		expect(html).toContain("Nothing here yet");
		expect(html).toContain("Write your first post");
	});
	test("search narrows the timeline to matching posts", async () => {
		const { container, dispose } = await mount(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			expect(timelinePostIds(container).sort()).toEqual([
				"thread-notes",
				"thread-triage",
			]);
			const search = container.querySelector<HTMLInputElement>(
				'input[type="search"]'
			);
			if (!search) {
				throw new Error("Expected the feed search field");
			}

			await typeInto(search, "crash");

			expect(timelinePostIds(container)).toEqual(["thread-triage"]);
			expect(container.textContent).toContain("Results for");

			await typeInto(search, "no such post");

			expect(timelinePostIds(container)).toEqual([]);
			expect(container.textContent).toContain("No results for");

			await click(container.querySelector('button[aria-label="Clear search"]'));

			expect(timelinePostIds(container)).toHaveLength(2);
		} finally {
			await dispose();
		}
	});

	test("the Working view shows only running threads", async () => {
		const { container, dispose } = await mount(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			// Working is a view in the navigation rail, beside Home and Pinned.
			const working = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((button) =>
				button.getAttribute("aria-label")?.startsWith("Working,")
			);

			await click(working);

			expect(timelinePostIds(container)).toEqual(["thread-triage"]);
		} finally {
			await dispose();
		}
	});

	test("the Needs you tab shows threads waiting on the user", async () => {
		const { container, dispose } = await mount(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			const needsYouTab = container.querySelector<HTMLButtonElement>(
				'[role="tab"][data-tab="needs-you"]'
			);

			expect(needsYouTab?.getAttribute("aria-selected")).toBe("false");

			await click(needsYouTab);

			expect(needsYouTab?.getAttribute("aria-selected")).toBe("true");
			expect(timelinePostIds(container)).toEqual(["thread-notes"]);
		} finally {
			await dispose();
		}
	});

	test("opening a post and messaging an agent go through the port", async () => {
		const opened: string[] = [];
		const started: unknown[] = [];
		const port: InterfacePort = {
			closeThread: () => undefined,
			openThread: (threadId) => {
				opened.push(threadId);
			},
			startThread: (input) => {
				started.push(input);
			},
		};
		const { container, dispose } = await mount(
			<FeedInterface
				activeThreadId={null}
				loading={false}
				params={{ order: "recent" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			await click(
				container.querySelector('button[data-feed-post="thread-notes"]')
			);
			await click(container.querySelector('button[aria-label="Message Ada"]'));

			expect(opened).toEqual(["thread-notes"]);
			expect(started).toEqual([{ agentId: "agent-ada" }]);
		} finally {
			await dispose();
		}
	});
});

describe("World2dInterface", () => {
	test("places one talkable agent per agent on a keyboard map", () => {
		const html = renderToStaticMarkup(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);

		expect(html).toContain('role="application"');
		expect(html.match(/aria-label="Talk to /g)).toHaveLength(2);
		expect(html).toContain('aria-label="Talk to Ada"');
		expect(html).toContain('aria-label="Talk to Grace"');
		expect(html).toContain('aria-label="You"');
		expect(html).not.toContain('data-testid="world-agent-panel"');
	});

	test("opens the agent panel for an already open thread", () => {
		const html = renderToStaticMarkup(
			<World2dInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{ theme: "night" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={THREAD_VIEW}
			/>
		);

		expect(html).toContain('aria-label="Talking to Grace"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("explains an empty world", () => {
		const html = renderToStaticMarkup(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "office" }}
				port={NOOP_PORT}
				snapshot={EMPTY_SNAPSHOT}
				threadView={null}
			/>
		);

		expect(html).not.toContain('aria-label="Talk to ');
		expect(html).toContain("No villagers yet");
		expect(html).toContain(">Start a conversation</button>");
	});

	test("talking to an agent opens, starts and leaves threads through the port", async () => {
		const calls: string[] = [];
		const port: InterfacePort = {
			closeThread: () => calls.push("close"),
			openThread: (threadId) => calls.push(`open:${threadId}`),
			startThread: (request) => calls.push(`start:${JSON.stringify(request)}`),
		};
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			await click(labelled(container, "button", "Talk to Ada"));
			const panel = labelled(container, "aside", "Talking to Ada");
			expect(panel.textContent).toContain("Past conversations");

			const pastThread = [...panel.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Release notes")
			);
			await click(pastThread);
			expect(calls).toContain("open:thread-notes");

			const composer = fieldLabelled(panel, "Say something to Ada");
			await typeInto(composer, "Tighten the summary");
			await act(async () => {
				composer.form?.requestSubmit();
			});
			expect(calls).toContain(
				`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Tighten the summary" })}`
			);

			calls.length = 0;
			await click(labelled(panel, "button", "Walk away"));
			expect(container.querySelector('[aria-label="Talking to Ada"]')).toBe(
				null
			);
			// No thread is open (the host never opened one), so walking away
			// has nothing to close.
			expect(calls).toEqual([]);
		} finally {
			await dispose();
		}
	});

	test("number keys visit villagers and M toggles the village map", async () => {
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			const map = labelled(
				container,
				'[role="application"]',
				"Agent world. Use arrow keys or WASD to walk, E to talk."
			);
			const mapCard = () =>
				container.querySelector('[aria-label^="Village map: "]');
			expect(mapCard()).toBe(null);
			await press(map, "m");
			expect(mapCard()?.getAttribute("aria-label")).toBe(
				"Village map: 2 villagers, 1 working"
			);
			await press(map, "m");
			expect(mapCard()).toBe(null);

			// Hotbar slots follow the village order (by name): 1 is Ada, 2 Grace.
			await press(map, "2");
			expect(
				container.querySelector('[aria-label="Talking to Grace"]')
			).not.toBe(null);
			await press(map, "Escape");
			expect(container.querySelector('[aria-label="Talking to Grace"]')).toBe(
				null
			);
		} finally {
			await dispose();
		}
	});
});

describe("World3dInterface", () => {
	test("exports a renderer component without rendering WebGL", async () => {
		const module = await import("./world-3d-interface.tsx");

		expect(typeof module.World3dInterface).toBe("function");
	});
});
