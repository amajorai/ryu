import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PostsInterface } from "./posts-interface.tsx";
import {
	ALL_VIEW,
	emptyDraft,
	GENERAL_SPACE_ID,
	HOME_VIEW,
	homeCount,
	homeSections,
	markerLabel,
	postMarker,
	postPrompt,
	postSpaces,
	postStartInput,
	resolveView,
	stepPost,
	viewHeader,
	viewPosts,
} from "./posts-model.ts";

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
			description: "Never posted",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-linus"],
			name: "Docs Crew",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Site",
		},
		{
			id: "project-empty",
			kind: "project",
			memberAgentIds: [],
			name: "Quiet Project",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 4,
			teamId: "team-docs",
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
			agentIds: ["agent-grace", "agent-ada"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			projectId: "project-site",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessage: null,
			lastMessageRole: null,
			messageCount: 0,
			pinned: true,
			title: "Loose ends",
			updatedAt: ago(600),
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

// Mounting the whole interface is slow on a loaded machine; keep margin.
setDefaultTimeout(20_000);

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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

/** A host that opens and closes threads in state, like the desktop does. */
function Host({
	calls,
	initialThreadId = null,
	snapshot = SNAPSHOT,
}: {
	calls: string[];
	initialThreadId?: string | null;
	snapshot?: InterfaceSnapshot;
}) {
	const [active, setActive] = useState<string | null>(initialThreadId);
	const threadView: ReactNode = active ? (
		<div data-testid="host-chat">chat for {active}</div>
	) : null;
	return (
		<PostsInterface
			activeThreadId={active}
			loading={false}
			params={{}}
			port={{
				closeThread: () => {
					calls.push("close");
					setActive(null);
				},
				openThread: (id) => {
					calls.push(`open:${id}`);
					setActive(id);
				},
				startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
			}}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(button) =>
			(button.getAttribute("aria-label") ?? button.textContent?.trim()) === name
	);
	if (!match) {
		throw new Error(`No button named ${name}`);
	}
	return match;
}

function postIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("article[data-thread-id]")].map(
		(article) => article.getAttribute("data-thread-id") ?? ""
	);
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function press(
	target: Element,
	key: string,
	init: KeyboardEventInit = {}
) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key, ...init })
		);
	});
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
		// react-dom loads before the DOM is registered, so it listens for the
		// legacy keyup path instead of `input`.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

describe("posts model", () => {
	test("maps thread status to Campsite's markers", () => {
		expect(postMarker("your-turn")).toBe("feedback-requested");
		expect(postMarker("attention")).toBe("needs-attention");
		expect(postMarker("quiet")).toBe("resolved");
		expect(postMarker("working")).toBe("in-progress");
		expect(postMarker("waiting")).toBe("awaiting-reply");
	});

	test("lists teams, then projects, then General for unfiled posts", () => {
		const spaces = postSpaces(SNAPSHOT);
		expect(spaces.map((space) => space.id)).toEqual([
			"team-docs",
			"project-site",
			"project-empty",
			GENERAL_SPACE_ID,
		]);
		const site = spaces.find((space) => space.id === "project-site");
		expect(site?.threadIds).toEqual(["thread-triage", "thread-flaky"]);
		expect(site?.needsYou).toBe(1);
		const general = spaces.find((space) => space.id === GENERAL_SPACE_ID);
		expect(general?.threadIds).toEqual(["thread-loose", "thread-question"]);
		expect(general?.memberAgentIds).toEqual(["agent-ada"]);
	});

	test("files threads with a missing group under General", () => {
		const spaces = postSpaces({
			...SNAPSHOT,
			threads: [thread({ id: "orphan", teamId: "team-gone" })],
		});
		expect(spaces.at(-1)?.threadIds).toEqual(["orphan"]);
	});

	test("Home holds failed runs and feedback requests, most urgent first", () => {
		const spaces = postSpaces(SNAPSHOT);
		const items = viewPosts(SNAPSHOT, HOME_VIEW, spaces);
		expect(homeCount(SNAPSHOT)).toBe(2);
		expect(
			homeSections(items).map((section) => [
				section.label,
				section.items.map((item) => item.thread.id),
			])
		).toEqual([
			["Needs attention", ["thread-flaky"]],
			["Feedback requested", ["thread-notes"]],
		]);
	});

	test("Posts puts pinned first, then most recent activity", () => {
		const items = viewPosts(SNAPSHOT, ALL_VIEW, postSpaces(SNAPSHOT));
		expect(items.map((item) => item.thread.id)).toEqual([
			"thread-loose",
			"thread-triage",
			"thread-notes",
			"thread-question",
			"thread-flaky",
		]);
	});

	test("a post counts comments after the first message and lists its agents", () => {
		const items = viewPosts(SNAPSHOT, ALL_VIEW, postSpaces(SNAPSHOT));
		const flaky = items.find((item) => item.thread.id === "thread-flaky");
		expect(flaky?.author?.name).toBe("Grace");
		expect(flaky?.commenters.map((agent) => agent.name)).toEqual([
			"Grace",
			"Ada",
		]);
		expect(flaky?.comments).toBe(1);
		const loose = items.find((item) => item.thread.id === "thread-loose");
		expect(loose?.author).toBeNull();
		expect(loose?.comments).toBe(0);
	});

	test("member views show the agent's posts and description", () => {
		const spaces = postSpaces(SNAPSHOT);
		const view = { agentId: "agent-ada", kind: "member" } as const;
		expect(
			viewPosts(SNAPSHOT, view, spaces).map((item) => item.thread.id)
		).toEqual(["thread-notes", "thread-question", "thread-flaky"]);
		expect(viewHeader(SNAPSHOT, view, spaces)).toMatchObject({
			description: "Writes the release notes",
			title: "Ada",
		});
	});

	test("space headers say what the space is, its members and posts", () => {
		const spaces = postSpaces(SNAPSHOT);
		const header = viewHeader(
			SNAPSHOT,
			{ id: "team-docs", kind: "space" },
			spaces
		);
		expect(header.title).toBe("Docs Crew");
		expect(header.description).toBe("Team · 2 members · 1 post");
		expect(header.members.map((agent) => agent.name)).toEqual(["Ada", "Linus"]);
	});

	test("Home and Posts headers carry no member facepile", () => {
		const spaces = postSpaces(SNAPSHOT);
		expect(viewHeader(SNAPSHOT, HOME_VIEW, spaces)).toEqual({
			description: "Feedback requests and failed runs",
			members: [],
			title: "Home",
		});
		expect(viewHeader(SNAPSHOT, ALL_VIEW, spaces)).toEqual({
			description: `${SNAPSHOT.threads.length} posts across ${spaces.length} spaces`,
			members: [],
			title: "Posts",
		});
	});

	test("markers read the same everywhere, named after the agent", () => {
		const [ada] = SNAPSHOT.agents;
		expect(markerLabel({ author: ada ?? null, marker: "awaiting-reply" })).toBe(
			"Waiting on Ada"
		);
		expect(markerLabel({ author: null, marker: "awaiting-reply" })).toBe(
			"Waiting for a reply"
		);
		expect(markerLabel({ author: ada ?? null, marker: "in-progress" })).toBe(
			"Ada is working"
		);
		expect(markerLabel({ author: ada ?? null, marker: "resolved" })).toBe(
			"Resolved"
		);
	});

	test("a view whose space or member left the snapshot falls back to Home", () => {
		const spaces = postSpaces(SNAPSHOT);
		expect(
			resolveView(SNAPSHOT, { id: "project-gone", kind: "space" }, spaces)
		).toEqual(HOME_VIEW);
		expect(
			resolveView(SNAPSHOT, { agentId: "agent-gone", kind: "member" }, spaces)
		).toEqual(HOME_VIEW);
	});

	test("a draft becomes one prompt filed under its space and agent", () => {
		const spaces = postSpaces(SNAPSHOT);
		expect(postPrompt({ body: "  ", title: "  " })).toBe("");
		expect(postPrompt({ body: "Body", title: "" })).toBe("Body");
		expect(
			postStartInput(
				{
					agentId: "agent-grace",
					body: "Why does CI flake?",
					spaceId: "project-site",
					title: "Flaky CI",
				},
				spaces
			)
		).toEqual({
			agentId: "agent-grace",
			projectId: "project-site",
			prompt: "Flaky CI\n\nWhy does CI flake?",
		});
		expect(
			postStartInput(
				{ agentId: null, body: "", spaceId: "team-docs", title: "Hi" },
				spaces
			)
		).toEqual({ prompt: "Hi", teamId: "team-docs" });
		expect(postStartInput(emptyDraft(HOME_VIEW), spaces)).toBeNull();
	});

	test("new drafts start in the current space or with the current member", () => {
		expect(emptyDraft({ id: "team-docs", kind: "space" }).spaceId).toBe(
			"team-docs"
		);
		expect(emptyDraft({ id: GENERAL_SPACE_ID, kind: "space" }).spaceId).toBe(
			null
		);
		expect(emptyDraft({ agentId: "agent-ada", kind: "member" }).agentId).toBe(
			"agent-ada"
		);
	});

	test("steps through posts and clamps at the ends", () => {
		const order = ["a", "b", "c"];
		expect(stepPost(order, null, 1)).toBe("a");
		expect(stepPost(order, null, -1)).toBe("c");
		expect(stepPost(order, "b", 1)).toBe("c");
		expect(stepPost(order, "c", 1)).toBe("c");
		expect(stepPost(order, "a", -1)).toBe("a");
		expect(stepPost([], null, 1)).toBeUndefined();
	});
});

describe("PostsInterface markup", () => {
	test("renders Home with a section per state and the sidebar", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<PostsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-posts"');
		expect(html).toContain("Needs attention");
		expect(html).toContain("Feedback requested");
		expect(html).toContain("Docs Crew");
		expect(html).toContain("Quiet Project");
		expect(html).toContain('aria-label="Home, 2 need you"');
		expect(html).not.toContain("Crash triage");
	});

	test("shows a skeleton while the first snapshot loads", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<PostsInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-slot="skeleton"');
		expect(html).not.toContain("No posts yet");
	});

	test("an empty workspace explains posts and offers New post", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<PostsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(html).toContain("No posts yet");
		expect(html).toContain("Agents you add in Ryu join as members");
		expect(html).toContain("New post");
	});
});

describe("PostsInterface interactions", () => {
	test("opening a post shows the host chat as comments with details", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Release notes"));
		expect(calls).toEqual(["open:thread-notes"]);
		const page = view.container.querySelector("[data-testid='posts-page']");
		expect(page?.querySelector("h1")?.textContent).toBe("Release notes");
		expect(
			view.container.querySelector(
				"[data-testid='posts-thread-view'] [data-testid='host-chat']"
			)?.textContent
		).toBe("chat for thread-notes");
		const details = view.container.querySelector(
			"[data-testid='posts-details']"
		);
		expect(details?.textContent).toContain("Docs Crew");
		expect(details?.textContent).toContain("Feedback requested");
		await click(buttonNamed(view.container, "Home, 2 need you"));
		expect(calls).toEqual(["open:thread-notes", "close"]);
		await view.dispose();
	});

	test("a post page names its way back and skips a lone participant", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-notes" />
		);
		const details = view.container.querySelector(
			"[data-testid='posts-details']"
		);
		expect(details?.textContent).not.toContain("Participants");
		const crumb = view.container.querySelector("nav[aria-label='Breadcrumb']");
		expect(crumb?.textContent).toContain("Home");
		await view.dispose();
	});

	test("Escape leaves an open post", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-flaky" />
		);
		const page = view.container.querySelector("[data-testid='posts-page']");
		if (!page) {
			throw new Error("post page missing");
		}
		await press(page, "Escape");
		expect(calls).toEqual(["close"]);
		expect(
			view.container.querySelector("[data-testid='posts-page']")
		).toBeNull();
		await view.dispose();
	});

	test("spaces and members narrow the feed", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Site, 1 needs you"));
		expect(postIds(view.container)).toEqual(["thread-triage", "thread-flaky"]);
		expect(view.container.querySelector("header h1")?.textContent).toBe("Site");
		await click(buttonNamed(view.container, "Grace, working"));
		expect(postIds(view.container)).toEqual(["thread-triage", "thread-flaky"]);
		await click(buttonNamed(view.container, "Posts"));
		expect(postIds(view.container)).toHaveLength(5);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("a new post in a space sends title and body through the port", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Site, 1 needs you"));
		await click(buttonNamed(view.container, "New post"));
		const form = view.container.querySelector("[data-testid='posts-composer']");
		const title = form?.querySelector("input");
		const body = form?.querySelector("textarea");
		if (!(title && body)) {
			throw new Error("composer missing");
		}
		expect(buttonNamed(view.container, "Post").disabled).toBe(true);
		await typeInto(title, "Flaky CI");
		await typeInto(body, "Why does CI flake on Fridays?");
		await click(buttonNamed(view.container, "Post"));
		expect(calls).toEqual([
			`start:${JSON.stringify({
				prompt: "Flaky CI\n\nWhy does CI flake on Fridays?",
				projectId: "project-site",
			})}`,
		]);
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).toBeNull();
		await view.dispose();
	});

	test("the composer never sends an empty post, and Escape discards it", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const root = view.container.querySelector(
			"[data-testid='interface-posts']"
		);
		if (!root) {
			throw new Error("root missing");
		}
		await press(root, "c");
		const title = view.container.querySelector<HTMLInputElement>(
			"[data-testid='posts-composer'] input"
		);
		if (!title) {
			throw new Error("composer missing");
		}
		await press(title, "Enter", { metaKey: true });
		expect(calls).toEqual([]);
		await press(title, "Escape");
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).toBeNull();
		await view.dispose();
	});

	test("j and k move focus between posts", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const root = view.container.querySelector(
			"[data-testid='interface-posts']"
		);
		if (!root) {
			throw new Error("root missing");
		}
		await press(root, "j");
		expect(document.activeElement?.textContent).toBe("Flaky test");
		await press(document.activeElement ?? root, "j");
		expect(document.activeElement?.textContent).toBe("Release notes");
		await press(document.activeElement ?? root, "k");
		expect(document.activeElement?.textContent).toBe("Flaky test");
		await view.dispose();
	});

	test("shortcuts work with focus on the page body", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await press(document.body, "j");
		expect(document.activeElement?.textContent).toBe("Flaky test");
		(document.activeElement as HTMLElement | null)?.blur();
		await press(document.body, "c");
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).not.toBeNull();
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("leaves body keys to the host's cover", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		// While the host covers Posts it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "j");
		expect(document.activeElement).toBe(document.body);
		await press(document.body, "c");
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).toBeNull();
		view.container.removeAttribute("inert");
		await press(document.body, "c");
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).not.toBeNull();
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("keys aimed at another app region are left alone", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const elsewhere = document.createElement("button");
		document.body.append(elsewhere);
		await press(elsewhere, "c");
		expect(
			view.container.querySelector("[data-testid='posts-composer']")
		).toBeNull();
		elsewhere.remove();
		await view.dispose();
	});
});
