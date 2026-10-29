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
import { StreamInterface } from "./stream-interface.tsx";
import {
	activityCount,
	activityPosts,
	agentsByActivity,
	defaultComposerAgent,
	feedPosts,
	profileFor,
	projectStreamPosts,
	replyLabel,
	searchStream,
	statusLine,
	threadCounts,
} from "./stream-model.ts";

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
		{
			avatarUrl: null,
			description: "Reviews pull requests",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is   ready\nfor review.",
			messageCount: 4,
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
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			id: "thread-orphan",
			lastMessage: "Office is closed Friday.",
			lastMessageRole: "user",
			messageCount: 1,
			title: "Office closed",
			updatedAt: ago(600),
		}),
		thread({
			agentIds: ["agent-grace", "agent-ada"],
			id: "thread-review",
			lastMessage: "Review done.",
			pinned: true,
			runState: "failed",
			teamId: "team-design",
			title: "Design review",
			updatedAt: ago(200),
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

function byLabel(container: HTMLElement, label: string): Element | null {
	return container.querySelector(`[aria-label="${label}"]`);
}

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
		// React falls back to key events when the DOM lacks `oninput`.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
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

function stream(
	port: InterfacePort,
	options: {
		activeThreadId?: string | null;
		loading?: boolean;
		snapshot?: InterfaceSnapshot;
		threadView?: ReactElement | null;
	} = {}
) {
	return (
		<StreamInterface
			activeThreadId={options.activeThreadId ?? null}
			loading={options.loading ?? false}
			params={{}}
			port={port}
			snapshot={options.snapshot ?? SNAPSHOT}
			threadView={options.threadView ?? null}
		/>
	);
}

function postIds(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("article[data-thread-id]")).map(
		(item) => item.getAttribute("data-thread-id") ?? ""
	);
}

describe("stream model", () => {
	test("projects each thread as a post by its lead agent, pinned first", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		expect(posts.map((post) => post.threadId)).toEqual([
			"thread-review",
			"thread-triage",
			"thread-notes",
			"thread-question",
			"thread-orphan",
		]);
		const review = posts[0];
		expect(review?.author?.name).toBe("Grace");
		expect(review?.faces.map((agent) => agent.name)).toEqual(["Ada"]);
		expect(review?.topic).toBe("Design Review");
		expect(review?.status).toBe("attention");
		const notes = posts.find((post) => post.threadId === "thread-notes");
		expect(notes?.body).toBe("Draft is ready for review.");
		expect(notes?.replyCount).toBe(3);
		// A lone agent's facepile is the agent itself, like a self-thread.
		expect(notes?.faces.map((agent) => agent.name)).toEqual(["Ada"]);
		const orphan = posts.find((post) => post.threadId === "thread-orphan");
		expect(orphan?.author).toBeUndefined();
		expect(orphan?.replyCount).toBe(0);
		const fresh = projectStreamPosts({
			...SNAPSHOT,
			threads: [
				thread({ id: "fresh", lastMessage: "Fix it", title: " Fix  it " }),
			],
		});
		// A thread titled from its only message shows that text once.
		expect(fresh[0]?.title).toBe("Fix it");
		expect(fresh[0]?.body).toBe("");
		expect(posts.find((post) => post.threadId === "thread-triage")?.topic).toBe(
			"Website"
		);
	});

	test("the Working feed holds only live runs", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		expect(feedPosts(posts, "for-you")).toHaveLength(posts.length);
		expect(feedPosts(posts, "working").map((post) => post.threadId)).toEqual([
			"thread-triage",
		]);
	});

	test("activity lists what waits on the user, failures first", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		expect(activityPosts(posts, "all").map((post) => post.threadId)).toEqual([
			"thread-review",
			"thread-notes",
		]);
		expect(activityPosts(posts, "failed").map((post) => post.threadId)).toEqual(
			["thread-review"]
		);
		expect(
			activityPosts(posts, "replies").map((post) => post.threadId)
		).toEqual(["thread-notes"]);
		expect(activityCount(posts)).toBe(2);
	});

	test("searches agents and posts case-insensitively", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		const agents = agentsByActivity(SNAPSHOT, posts);
		expect(searchStream(agents, posts, "")).toEqual({ agents, posts: [] });
		const crash = searchStream(agents, posts, "  CRASH ");
		expect(crash.agents).toEqual([]);
		expect(crash.posts.map((post) => post.threadId)).toEqual(["thread-triage"]);
		const bugs = searchStream(agents, posts, "bugs");
		expect(bugs.agents.map((agent) => agent.name)).toEqual(["Grace"]);
		const design = searchStream(agents, posts, "design review");
		expect(design.posts.map((post) => post.threadId)).toEqual([
			"thread-review",
		]);
	});

	test("orders agents by their latest conversation", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		expect(
			agentsByActivity(SNAPSHOT, posts).map((agent) => agent.name)
		).toEqual(["Grace", "Ada", "Linus"]);
		const agents = agentsByActivity(SNAPSHOT, posts);
		expect(defaultComposerAgent(agents, null)?.name).toBe("Grace");
		expect(defaultComposerAgent(agents, "agent-linus")?.name).toBe("Linus");
		expect(defaultComposerAgent(agents, "agent-gone")?.name).toBe("Grace");
		expect(threadCounts(posts).get("agent-ada")).toBe(2);
	});

	test("a profile splits led threads from joined ones", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		const ada = profileFor(SNAPSHOT, posts, "agent-ada");
		expect(ada?.threads.map((post) => post.threadId)).toEqual([
			"thread-notes",
			"thread-question",
		]);
		expect(ada?.replies.map((post) => post.threadId)).toEqual([
			"thread-review",
		]);
		expect(ada?.groups.map((group) => group.name)).toEqual(["Design Review"]);
		expect(ada?.teammates.map((agent) => agent.name)).toEqual(["Grace"]);
		expect(profileFor(SNAPSHOT, posts, "agent-gone")).toBeNull();
		expect(profileFor(SNAPSHOT, posts, null)).toBeNull();
	});

	test("says where each conversation stands", () => {
		const posts = projectStreamPosts(SNAPSHOT);
		const line = (id: string) =>
			statusLine(posts.find((post) => post.threadId === id) ?? posts[0]!);
		expect(line("thread-triage")).toEqual({
			text: "Grace is replying",
			tone: "live",
		});
		expect(line("thread-review")).toEqual({
			text: "Run failed",
			tone: "attention",
		});
		expect(line("thread-notes")).toEqual({ text: "Your turn", tone: "strong" });
		expect(line("thread-question")).toEqual({
			text: "Waiting on Ada",
			tone: "muted",
		});
		// Nobody to wait on.
		expect(line("thread-orphan")).toBeNull();
		expect(replyLabel(1)).toBe("1 reply");
		expect(replyLabel(9)).toBe("9 replies");
	});
});

describe("stream interface", () => {
	test("renders the rail, the composer and one post per thread", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(stream(port));
		expect(html).toContain('data-testid="interface-stream"');
		expect(html).toContain('aria-label="New thread"');
		expect(html).toContain("What&#x27;s new?");
		expect(html).toContain("Design review");
		expect(html).toContain("3 replies");
		expect(html).toContain("Grace is replying");
		expect(html).toContain("Pinned");
		expect(html).toContain('aria-label="Activity, 2 waiting on you"');
		expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
	});

	test("shows a skeleton while loading and plain empty states", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(stream(port, { loading: true }));
		expect(loading).toContain('aria-label="Loading threads"');
		expect(loading).not.toContain("data-thread-id");
		const empty = renderToStaticMarkup(stream(port, { snapshot: EMPTY }));
		expect(empty).toContain("No threads yet");
		expect(empty).toContain("Add an agent to start your first thread.");
		expect(empty).not.toContain('aria-label="New thread"');
	});

	test("opening a post asks the host for that thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(stream(port));
		const triage = view.container.querySelector(
			'article[data-thread-id="thread-triage"] button.block'
		);
		await click(triage);
		await click(
			view.container.querySelector('[aria-label^="Reply to Release notes"]')
		);
		expect(calls).toEqual(["open:thread-triage", "open:thread-notes"]);
		await view.dispose();
	});

	test("Post sends exactly the typed prompt to the picked agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(stream(port));
		const form = view.container.querySelector("form");
		const field = view.container.querySelector("textarea");
		if (!(form && field)) {
			throw new Error("Composer missing");
		}
		const post = form.querySelector('button[type="submit"]');
		expect(post?.hasAttribute("disabled")).toBeTrue();
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([]);
		await typeInto(field, "  Ship the fix  ");
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-grace", prompt: "Ship the fix" })}`,
		]);
		expect(field.value).toBe("");
		await view.dispose();
	});

	test("an open thread shows the post above the host's conversation", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			stream(port, {
				activeThreadId: "thread-review",
				threadView: <div data-testid="host-chat">chat</div>,
			})
		);
		const pane = view.container.querySelector(
			'[data-testid="stream-thread-view"]'
		);
		expect(pane?.querySelector('[data-testid="host-chat"]')).not.toBeNull();
		expect(postIds(view.container)).toEqual(["thread-review"]);
		expect(view.container.textContent).toContain("Replies");
		// No second send path: the composer is gone while a thread is open.
		expect(view.container.querySelector("textarea")).toBeNull();
		await click(byLabel(view.container, "Back"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("a new thread with no post yet still shows the host view", async () => {
		const { port } = recordingPort();
		const view = await mount(
			stream(port, { threadView: <div data-testid="host-chat">chat</div> })
		);
		expect(view.container.querySelector("h1")?.textContent).toBe("New thread");
		expect(
			view.container.querySelector('[data-testid="host-chat"]')
		).not.toBeNull();
		await view.dispose();
	});

	test("Working, Activity, Search and Profile filter the same posts", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(stream(port));
		const tab = (name: string) =>
			Array.from(view.container.querySelectorAll('[role="tab"]')).find(
				(item) => item.textContent === name
			);
		await click(tab("Working"));
		expect(postIds(view.container)).toEqual(["thread-triage"]);

		await click(byLabel(view.container, "Activity, 2 waiting on you"));
		expect(view.container.querySelector("h1")?.textContent).toBe("Activity");
		const rows = view.container.querySelectorAll(
			'ul[aria-label="Waiting on you"] button'
		);
		expect(rows).toHaveLength(2);
		await click(rows[0]);
		expect(calls).toEqual(["open:thread-review"]);

		await click(byLabel(view.container, "Search"));
		const input = view.container.querySelector('input[type="search"]');
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Search input missing");
		}
		expect(view.container.textContent).toContain("Your agents");
		await typeInto(input, "intro");
		expect(postIds(view.container)).toEqual(["thread-question"]);
		await typeInto(input, "zzz");
		expect(view.container.textContent).toContain("No results for “zzz”");

		await click(byLabel(view.container, "Profile"));
		expect(view.container.querySelector("h2")?.textContent).toBe("Grace");
		await view.dispose();
	});

	test("a profile lists the agent's threads and messages them", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(stream(port));
		await click(byLabel(view.container, "View Ada’s profile"));
		expect(view.container.querySelector("h2")?.textContent).toBe("Ada");
		expect(view.container.textContent).toContain("@ada");
		expect(postIds(view.container)).toEqual([
			"thread-notes",
			"thread-question",
		]);
		const replies = Array.from(
			view.container.querySelectorAll('[role="tab"]')
		).find((item) => item.textContent === "Replies");
		await click(replies);
		expect(postIds(view.container)).toEqual(["thread-review"]);
		const message = Array.from(view.container.querySelectorAll("button")).find(
			(item) => item.textContent === "Message"
		);
		await click(message);
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada" })}`,
		]);
		await view.dispose();
	});

	test("feed tabs rove with the arrow keys and label their panel", async () => {
		const { port } = recordingPort();
		const view = await mount(stream(port));
		const tabs = Array.from(view.container.querySelectorAll('[role="tab"]'));
		const [forYou, working] = tabs;
		if (!(forYou instanceof HTMLElement && working instanceof HTMLElement)) {
			throw new Error("Feed tabs missing");
		}
		expect(forYou.tabIndex).toBe(0);
		expect(working.tabIndex).toBe(-1);
		const panel = view.container.querySelector('[role="tabpanel"]');
		expect(panel?.getAttribute("aria-labelledby")).toBe(forYou.id);
		expect(forYou.getAttribute("aria-controls")).toBe(panel?.id ?? "");
		await act(async () => {
			forYou.focus();
			forYou.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(document.activeElement).toBe(working);
		expect(working.getAttribute("aria-selected")).toBe("true");
		expect(postIds(view.container)).toEqual(["thread-triage"]);
		await view.dispose();
	});

	test("Reply on a post page focuses the host's composer", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			stream(port, {
				activeThreadId: "thread-review",
				threadView: (
					<div data-testid="host-chat">
						<textarea aria-label="Host composer" />
					</div>
				),
			})
		);
		await click(view.container.querySelector('[aria-label^="Reply to"]'));
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Host composer"
		);
		expect(calls).toEqual([]);
		// The rail keeps the page the post was opened from.
		expect(byLabel(view.container, "Home")?.getAttribute("aria-current")).toBe(
			"page"
		);
		await view.dispose();
	});

	test("the profile name switches to another agent", async () => {
		const { port } = recordingPort();
		const view = await mount(stream(port));
		await click(byLabel(view.container, "View Ada’s profile"));
		const trigger = byLabel(view.container, "Ada. Switch profile");
		expect(trigger).not.toBeNull();
		expect(view.container.querySelector("h2")?.textContent).toBe("Ada");
		await view.dispose();
	});
});
