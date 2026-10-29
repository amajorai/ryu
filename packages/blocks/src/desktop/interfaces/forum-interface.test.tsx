import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumInterface } from "./forum-interface.tsx";
import {
	composerCategories,
	draftPrompt,
	draftStartInput,
	emptyDraft,
	forumCategories,
	forumTopic,
	joinNames,
	postFraction,
	progressPost,
	stepTopic,
	swatchColor,
	topicCategoryId,
	topicList,
	topicStatusNote,
	UNCATEGORIZED_ID,
	unreadCount,
} from "./forum-model.ts";

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
			messageCount: 9,
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

/** A host that opens and closes threads in state, like the desktop does. */
function Host({
	calls,
	initialThreadId = null,
	loading = false,
	snapshot = SNAPSHOT,
}: {
	calls: string[];
	initialThreadId?: string | null;
	loading?: boolean;
	snapshot?: InterfaceSnapshot;
}) {
	const [active, setActive] = useState<string | null>(initialThreadId);
	const threadView: ReactNode = active ? (
		<div data-testid="host-chat">chat for {active}</div>
	) : null;
	return (
		<ForumInterface
			activeThreadId={active}
			loading={loading}
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

function accessibleName(element: Element): string {
	return (
		element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
	);
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(button) => accessibleName(button) === name
	);
	if (!match) {
		throw new Error(`No button named ${name}`);
	}
	return match;
}

function topicIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("tr[data-thread-id]")].map(
		(row) => row.getAttribute("data-thread-id") ?? ""
	);
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
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

describe("forum model", () => {
	test("lists projects, then teams, then agents, then Uncategorized", () => {
		const categories = forumCategories(SNAPSHOT);
		expect(categories.map((category) => category.id)).toEqual([
			"project-site",
			"team-docs",
			"agent-ada",
			"agent-grace",
			"agent-linus",
			UNCATEGORIZED_ID,
		]);
		const site = categories[0];
		expect(site?.topicIds).toEqual(["thread-triage", "thread-flaky"]);
		expect(site?.latest?.id).toBe("thread-triage");
		expect(site?.description).toBe("With Grace");
		expect(categories.find((c) => c.id === "agent-linus")?.latest).toBeNull();
		expect(categories.map((category) => category.swatch)).toEqual([
			0, 1, 2, 3, 4, 5,
		]);
	});

	test("files a topic under its project, team, agent, or Uncategorized", () => {
		const known = new Set(["project-site", "team-docs", "agent-ada"]);
		expect(
			topicCategoryId(
				thread({ id: "a", projectId: "project-site", teamId: "team-docs" }),
				known
			)
		).toBe("project-site");
		expect(
			topicCategoryId(
				thread({ agentIds: ["agent-ada"], id: "b", projectId: "project-gone" }),
				known
			)
		).toBe("agent-ada");
		expect(topicCategoryId(thread({ id: "c" }), known)).toBe(UNCATEGORIZED_ID);
	});

	test("leaves Uncategorized out until a topic needs it", () => {
		const categories = forumCategories({
			...SNAPSHOT,
			threads: [thread({ agentIds: ["agent-ada"], id: "solo" })],
		});
		expect(categories.some((c) => c.id === UNCATEGORIZED_ID)).toBe(false);
		expect(composerCategories(categories).at(-1)?.id).toBe(UNCATEGORIZED_ID);
	});

	test("Latest pins first, Top ranks by posts, Unread keeps your turn", () => {
		const categories = forumCategories(SNAPSHOT);
		const ids = (sort: "latest" | "top" | "unread") =>
			topicList(SNAPSHOT, categories, {
				categoryId: null,
				search: "",
				sort,
			}).map((topic) => topic.thread.id);
		expect(ids("latest")).toEqual([
			"thread-loose",
			"thread-triage",
			"thread-notes",
			"thread-question",
			"thread-flaky",
		]);
		expect(ids("top")[0]).toBe("thread-triage");
		expect(ids("unread")).toEqual(["thread-notes"]);
		expect(unreadCount(SNAPSHOT)).toBe(1);
		expect(unreadCount(SNAPSHOT, "project-site", categories)).toBe(0);
	});

	test("filters by category and by every search word", () => {
		const categories = forumCategories(SNAPSHOT);
		const inSite = topicList(SNAPSHOT, categories, {
			categoryId: "project-site",
			search: "",
			sort: "latest",
		});
		expect(inSite.map((topic) => topic.thread.id)).toEqual([
			"thread-triage",
			"thread-flaky",
		]);
		const found = topicList(SNAPSHOT, categories, {
			categoryId: null,
			search: "crash GRACE",
			sort: "latest",
		});
		expect(found.map((topic) => topic.thread.id)).toEqual(["thread-triage"]);
	});

	test("reads a topic's counts, author, and status note", () => {
		const categories = forumCategories(SNAPSHOT);
		const byId = (id: string) => {
			const found = SNAPSHOT.threads.find((item) => item.id === id);
			if (!found) {
				throw new Error(id);
			}
			return forumTopic(SNAPSHOT, found, categories);
		};
		const triage = byId("thread-triage");
		expect(triage.replies).toBe(8);
		expect(triage.views).toBe(9);
		expect(triage.author?.name).toBe("Grace");
		expect(topicStatusNote(triage)).toBe("Working");
		expect(byId("thread-question").author).toBeNull();
		expect(topicStatusNote(byId("thread-flaky"))).toBe("Run failed");
		expect(byId("thread-loose").replies).toBe(0);
	});

	test("steps through a list and clamps at its ends", () => {
		const order = ["a", "b", "c"];
		expect(stepTopic(order, null, 1)).toBe("a");
		expect(stepTopic(order, null, -1)).toBe("c");
		expect(stepTopic(order, "b", 1)).toBe("c");
		expect(stepTopic(order, "c", 1)).toBe("c");
		expect(stepTopic([], null, 1)).toBeNull();
	});

	test("maps scroll fractions to post numbers and back", () => {
		expect(progressPost(0, 9)).toBe(1);
		expect(progressPost(1, 9)).toBe(9);
		expect(progressPost(0.5, 9)).toBe(5);
		expect(progressPost(2, 9)).toBe(9);
		expect(progressPost(0.5, 1)).toBe(1);
		expect(postFraction(5, 9)).toBe(0.5);
		expect(postFraction(1, 1)).toBe(0);
	});

	test("turns a draft into a startThread input for its category", () => {
		const categories = composerCategories(forumCategories(SNAPSHOT));
		expect(draftStartInput(emptyDraft("project-site"), categories)).toBeNull();
		expect(
			draftStartInput(
				{ ...emptyDraft("project-site"), body: " Why? ", title: " Crash " },
				categories
			)
		).toEqual({ projectId: "project-site", prompt: "Crash\n\nWhy?" });
		expect(
			draftStartInput(
				{ ...emptyDraft("team-docs"), agentId: "agent-linus", title: "Plan" },
				categories
			)
		).toEqual({ agentId: "agent-linus", prompt: "Plan", teamId: "team-docs" });
		expect(
			draftStartInput(
				{ ...emptyDraft("agent-ada"), agentId: "agent-grace", title: "Hi" },
				categories
			)
		).toEqual({ agentId: "agent-ada", prompt: "Hi" });
		expect(draftPrompt({ body: "only a body", title: "" })).toBe("");
	});

	test("derives swatches from the theme's primary, never a fixed colour", () => {
		expect(swatchColor(0)).toContain("var(--primary)");
		expect(swatchColor(3)).toContain("var(--primary)");
		expect(swatchColor(0)).not.toBe(swatchColor(1));
		expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
	});
});

describe("forum interface", () => {
	test("renders Discourse's topic list with its columns", () => {
		const html = renderToStaticMarkup(<Host calls={[]} />);
		expect(html).toContain('data-testid="interface-forum"');
		for (const heading of ["Topic", "Replies", "Views", "Activity"]) {
			expect(html).toContain(`>${heading}</th>`);
		}
		expect(html).toContain("There are no more latest topics.");
		expect(html).toContain("Unread");
		expect(html).toContain("New topic");
	});

	test("shows a skeleton while loading and an empty state with nothing", () => {
		const loading = renderToStaticMarkup(<Host calls={[]} loading />);
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(<Host calls={[]} snapshot={EMPTY} />);
		expect(empty).toContain('data-testid="forum-empty"');
		expect(empty).toContain("No topics yet");
	});

	test("opens a topic as a page with the host's chat as its replies", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		expect(topicIds(view.container)[0]).toBe("thread-loose");
		await click(buttonNamed(view.container, "Crash triage"));
		expect(calls).toEqual(["open:thread-triage"]);
		const page = view.container.querySelector("[data-testid='forum-topic']");
		expect(page?.querySelector("h1")?.textContent).toBe("Crash triage");
		expect(
			page?.querySelector("[data-testid='forum-opening-post']")?.textContent
		).toContain("Looking at the crash reports now.");
		const replies = page?.querySelector("[data-testid='forum-thread-view']");
		expect(replies?.querySelector("[data-testid='host-chat']")).not.toBeNull();
		expect(
			page?.querySelector("[role='slider']")?.getAttribute("aria-valuemax")
		).toBe("9");
		await press(document.body, "Escape");
		expect(calls).toEqual(["open:thread-triage", "close"]);
		expect(
			view.container.querySelector("[data-testid='forum-topic']")
		).toBeNull();
		await view.dispose();
	});

	test("switches between Latest, Top, Unread, and Categories", async () => {
		const view = await mount(<Host calls={[]} />);
		await click(buttonNamed(view.container, "Unread(1)"));
		expect(topicIds(view.container)).toEqual(["thread-notes"]);
		await click(buttonNamed(view.container, "Top"));
		expect(topicIds(view.container)[0]).toBe("thread-triage");
		await click(buttonNamed(view.container, "Categories"));
		const table = view.container.querySelector(
			"[data-testid='forum-categories']"
		);
		expect(table?.textContent).toContain("Projects");
		expect(table?.textContent).toContain("Teams");
		expect(table?.textContent).toContain("Agents");
		await click(buttonNamed(view.container, "Site"));
		expect(view.container.querySelector("h1")?.textContent).toBe("Site");
		expect(topicIds(view.container)).toEqual(["thread-triage", "thread-flaky"]);
		await view.dispose();
	});

	test("moves through topics with j and k and opens with o", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await press(document.body, "j");
		await press(document.body, "j");
		const selected = view.container.querySelector("tr[data-selected]");
		expect(selected?.getAttribute("data-thread-id")).toBe("thread-triage");
		await press(document.body, "k");
		expect(
			view.container
				.querySelector("tr[data-selected]")
				?.getAttribute("data-thread-id")
		).toBe("thread-loose");
		await press(document.body, "o");
		expect(calls).toEqual(["open:thread-loose"]);
		await view.dispose();
	});

	test("leaves keys to a page over it and to the host's cover", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const selected = () =>
			view.container
				.querySelector("tr[data-selected]")
				?.getAttribute("data-thread-id") ?? null;
		// A page the host shows over the forum (Settings, an app) owns its keys.
		const page = document.createElement("section");
		const toggle = document.createElement("button");
		page.append(toggle);
		document.body.append(page);
		await press(toggle, "j");
		await press(toggle, "c");
		expect(selected()).toBeNull();
		// While the host covers the forum it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "j");
		await press(document.body, "c");
		expect(selected()).toBeNull();
		expect(document.querySelector("[data-testid='forum-composer']")).toBeNull();
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press(document.body, "j");
		expect(selected()).toBe("thread-loose");
		page.remove();
		await view.dispose();
	});

	test("searches topics from the header", async () => {
		const view = await mount(<Host calls={[]} />);
		const search = view.container.querySelector<HTMLInputElement>(
			"input[type='search']"
		);
		if (!search) {
			throw new Error("No search field");
		}
		await typeInto(search, "flaky");
		expect(topicIds(view.container)).toEqual(["thread-flaky"]);
		expect(view.container.textContent).toContain("1 result for");
		await view.dispose();
	});

	test("creates a topic in the current category from the composer", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Category: Site"));
		await click(buttonNamed(view.container, "New topic"));
		const composer = view.container.querySelector(
			"[data-testid='forum-composer']"
		);
		const title = composer?.querySelector<HTMLInputElement>("input");
		const body = composer?.querySelector<HTMLTextAreaElement>("textarea");
		if (!(title && body)) {
			throw new Error("Composer fields missing");
		}
		const create = buttonNamed(view.container, "Create topic");
		expect(create.disabled).toBe(true);
		await typeInto(title, "Ship the fix");
		await typeInto(body, "Patch the flaky test first.");
		await click(buttonNamed(view.container, "Create topic"));
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.replace(/^start:/, "") ?? "null")).toEqual({
			projectId: "project-site",
			prompt: "Ship the fix\n\nPatch the flaky test first.",
		});
		expect(
			view.container.querySelector(
				"[data-testid='forum-composer'][data-state='open']"
			)
		).toBeNull();
		await view.dispose();
	});

	test("Escape tucks the composer away with its draft", async () => {
		const view = await mount(<Host calls={[]} />);
		await click(buttonNamed(view.container, "New topic"));
		const title = view.container.querySelector<HTMLInputElement>(
			"[data-testid='forum-composer'] input"
		);
		if (!title) {
			throw new Error("No title field");
		}
		await typeInto(title, "Half an idea");
		await press(title, "Escape");
		expect(
			view.container.querySelector("[data-testid='forum-composer']")
		).toBeNull();
		expect(view.container.textContent).toContain("Half an idea");
		await click(buttonNamed(view.container, "Expand composer"));
		expect(
			view.container.querySelector<HTMLInputElement>(
				"[data-testid='forum-composer'] input"
			)?.value
		).toBe("Half an idea");
		await view.dispose();
	});
});
