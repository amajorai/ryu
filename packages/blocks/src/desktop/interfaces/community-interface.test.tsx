import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityInterface } from "./community-interface.tsx";
import {
	buildCommunities,
	buildPosts,
	type CommunityPost,
	commentCount,
	communityFeed,
	communityHandle,
	displayScore,
	draftPrompt,
	draftStartInput,
	emptyDraft,
	flairLabel,
	hotRank,
	messageInput,
	nextVote,
	PROFILE_KEY,
	posterLabel,
	primaryCommunity,
	rankedCommunities,
	redditAge,
	shortCount,
	sortPosts,
	stepPost,
	TITLE_LIMIT,
} from "./community-model.ts";

const MINUTE = 60_000;
// Relative to the real clock, so the mounted interface sees the same "now".
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
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada"],
			name: "Docs Crew",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Site v2!",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 4,
			teamId: "team-docs",
			title: "Release notes draft",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			messageCount: 3,
			title: "Shorten the intro",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 2,
			projectId: "project-site",
			running: true,
			title: "Safari crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace", "agent-ada"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			messageCount: 30,
			pinned: true,
			projectId: "project-site",
			runState: "failed",
			teamId: "team-docs",
			title: "Find the flaky test",
			updatedAt: ago(60 * 30),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Office closed Friday.",
			lastMessageRole: "user",
			messageCount: 1,
			title: "Office closed Friday",
			updatedAt: ago(60 * 24 * 3),
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

const COMMUNITIES = buildCommunities(SNAPSHOT);
const POSTS = buildPosts(SNAPSHOT, COMMUNITIES);

function postById(id: string): CommunityPost {
	const post = POSTS.find((candidate) => candidate.thread.id === id);
	if (!post) {
		throw new Error(`fixture missing ${id}`);
	}
	return post;
}

const ids = (posts: readonly CommunityPost[]) =>
	posts.map((post) => post.thread.id);

describe("community model", () => {
	test("handles run words together and drop punctuation", () => {
		expect(communityHandle("Website Redesign")).toBe("WebsiteRedesign");
		expect(communityHandle("site v2!")).toBe("SiteV2");
		expect(communityHandle("  ")).toBe("Community");
		expect(communityHandle("a".repeat(40))).toHaveLength(21);
	});

	test("communities list projects, teams, agents, then the profile", () => {
		expect(COMMUNITIES.map((community) => community.key)).toEqual([
			"project:project-site",
			"team:team-docs",
			"agent:agent-ada",
			"agent:agent-grace",
			PROFILE_KEY,
		]);
		const site = COMMUNITIES[0];
		expect(site?.handle).toBe("SiteV2");
		// Declared members plus agents on the project's threads.
		expect(site?.members.map((agent) => agent.id)).toEqual([
			"agent-grace",
			"agent-ada",
		]);
		expect(site?.workingCount).toBe(1);
		expect(site?.threadCount).toBe(2);
		expect(site?.lastActivity).toBe(ago(5));
		const ada = COMMUNITIES.find(
			(community) => community.key === "agent:agent-ada"
		);
		expect(ada?.threadCount).toBe(3);
		expect(ada?.description).toBe("Writes the release notes");
	});

	test("the profile only appears when a thread has nowhere else to go", () => {
		const housed = buildCommunities({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-loose"),
		});
		expect(housed.some((community) => community.key === PROFILE_KEY)).toBe(
			false
		);
	});

	test("repeated names get numbered handles", () => {
		const communities = buildCommunities({
			...SNAPSHOT,
			groups: [
				...SNAPSHOT.groups,
				{ id: "team-ada", kind: "team", memberAgentIds: [], name: "Ada" },
			],
		});
		const handles = communities.map((community) => community.handle);
		expect(handles).toContain("Ada");
		expect(handles).toContain("Ada2");
		expect(new Set(handles).size).toBe(handles.length);
	});

	test("a post is filed under its project, then team, then agent, then profile", () => {
		expect(postById("thread-flaky").community.key).toBe("project:project-site");
		expect(postById("thread-notes").community.key).toBe("team:team-docs");
		expect(postById("thread-intro").community.key).toBe("agent:agent-ada");
		expect(postById("thread-loose").community.key).toBe(PROFILE_KEY);
		expect(primaryCommunity([], thread({ id: "orphan" })).prefix).toBe("u/");
	});

	test("score and comments come from the message count", () => {
		const post = postById("thread-notes");
		expect(post.score).toBe(4);
		expect(post.comments).toBe(3);
		expect(commentCount(thread({ id: "none", messageCount: 0 }))).toBe(0);
		expect(displayScore(post, 1)).toBe(5);
		expect(displayScore(post, -1)).toBe(3);
		expect(displayScore(post, undefined)).toBe(4);
		expect(postById("thread-intro").poster?.name).toBe("Ada");
		expect(postById("thread-loose").poster).toBeNull();
	});

	test("votes toggle the way Reddit's arrows do", () => {
		expect(nextVote(undefined, 1)).toBe(1);
		expect(nextVote(1, 1)).toBeUndefined();
		expect(nextVote(1, -1)).toBe(-1);
		expect(nextVote(-1, -1)).toBeUndefined();
	});

	test("hot rank trades a tenfold score for 12.5 hours", () => {
		const base = hotRank(10, ago(0));
		expect(hotRank(100, ago(750))).toBeCloseTo(base, 5);
		expect(hotRank(10, ago(1))).toBeLessThan(base);
		expect(hotRank(0, ago(0))).toBeLessThan(base);
		expect(Number.isFinite(hotRank(5, "not a date"))).toBe(true);
	});

	test("New, Top, and Hot order posts; only a community's Hot pins", () => {
		expect(ids(sortPosts(POSTS, "new"))).toEqual([
			"thread-triage",
			"thread-notes",
			"thread-intro",
			"thread-flaky",
			"thread-loose",
		]);
		expect(ids(sortPosts(POSTS, "top"))[0]).toBe("thread-flaky");
		expect(ids(sortPosts(POSTS, "hot"))[0]).toBe("thread-notes");
		expect(ids(sortPosts(POSTS, "hot", true))[0]).toBe("thread-flaky");
	});

	test("feeds narrow by scope, popularity, and search", () => {
		const feed = (input: Partial<Parameters<typeof communityFeed>[0]>) =>
			ids(
				communityFeed({
					communities: COMMUNITIES,
					now: NOW,
					posts: POSTS,
					query: "",
					scope: { kind: "home" },
					sort: "new",
					...input,
				})
			);
		expect(feed({})).toHaveLength(5);
		expect(
			feed({ scope: { key: "agent:agent-ada", kind: "community" } })
		).toEqual(["thread-notes", "thread-intro", "thread-flaky"]);
		expect(
			feed({ scope: { key: "team:team-docs", kind: "community" } })
		).toEqual(["thread-notes", "thread-flaky"]);
		expect(feed({ scope: { key: PROFILE_KEY, kind: "community" } })).toEqual([
			"thread-loose",
		]);
		expect(feed({ scope: { key: "missing", kind: "community" } })).toEqual([]);
		expect(feed({ scope: { kind: "popular" } })).toEqual([
			"thread-triage",
			"thread-notes",
			"thread-intro",
		]);
		expect(feed({ query: "safari" })).toEqual(["thread-triage"]);
		expect(feed({ query: "docs crew draft" })).toEqual(["thread-notes"]);
		expect(feed({ query: "r/sitev2" })).toEqual([
			"thread-triage",
			"thread-flaky",
		]);
		expect(feed({ query: "grace" })).toEqual(["thread-triage", "thread-flaky"]);
	});

	test("the rail ranks communities by threads and leaves out the profile", () => {
		expect(
			rankedCommunities(COMMUNITIES).map((community) => community.key)
		).toEqual([
			"agent:agent-ada",
			// Ties break on live runs, then name; Grace works on Docs Crew too.
			"team:team-docs",
			"agent:agent-grace",
			"project:project-site",
		]);
	});

	test("a draft needs a title and a community before it can post", () => {
		expect(draftPrompt({ ...emptyDraft(), title: "  " })).toBe("");
		expect(
			draftStartInput({ ...emptyDraft(), title: "Hi" }, COMMUNITIES)
		).toBeNull();
		expect(
			draftStartInput(
				{ ...emptyDraft("project:project-site"), body: "x" },
				COMMUNITIES
			)
		).toBeNull();
		expect(
			draftStartInput(
				{
					body: "  Only on iOS.  ",
					communityKey: "project:project-site",
					title: " Crash? ",
				},
				COMMUNITIES
			)
		).toEqual({ projectId: "project-site", prompt: "Crash?\n\nOnly on iOS." });
		expect(
			draftStartInput(
				{ ...emptyDraft("team:team-docs"), title: "Plan" },
				COMMUNITIES
			)
		).toEqual({ prompt: "Plan", teamId: "team-docs" });
		expect(
			draftStartInput(
				{ ...emptyDraft("agent:agent-ada"), title: "Hey" },
				COMMUNITIES
			)
		).toEqual({ agentId: "agent-ada", prompt: "Hey" });
		expect(
			draftStartInput({ ...emptyDraft(PROFILE_KEY), title: "Note" }, [])
		).toEqual({ prompt: "Note" });
		expect(
			draftPrompt({ ...emptyDraft(), title: "a".repeat(TITLE_LIMIT + 20) })
		).toHaveLength(TITLE_LIMIT);
	});

	test("Message files a promptless thread in the community", () => {
		const [site, docs, ada] = COMMUNITIES;
		if (!(site && docs && ada)) {
			throw new Error("fixture missing");
		}
		expect(messageInput(site, "agent-grace")).toEqual({
			agentId: "agent-grace",
			projectId: "project-site",
		});
		expect(messageInput(docs, "agent-ada")).toEqual({
			agentId: "agent-ada",
			teamId: "team-docs",
		});
		expect(messageInput(ada, "agent-ada")).toEqual({ agentId: "agent-ada" });
	});

	test("ages, counts, labels, and flair read like Reddit", () => {
		expect(redditAge(ago(0), NOW)).toBe("just now");
		expect(redditAge(ago(1), NOW)).toBe("1 min. ago");
		expect(redditAge(ago(150), NOW)).toBe("2 hr. ago");
		expect(redditAge(ago(60 * 24), NOW)).toBe("1 day ago");
		expect(redditAge(ago(60 * 24 * 3), NOW)).toBe("3 days ago");
		expect(redditAge(ago(60 * 24 * 65), NOW)).toBe("2 mo. ago");
		expect(redditAge("nope", NOW)).toBe("");
		expect(shortCount(999)).toBe("999");
		expect(shortCount(1234)).toBe("1.2k");
		expect(shortCount(12_600)).toBe("13k");
		expect(posterLabel(null)).toBe("u/you");
		expect(posterLabel(SNAPSHOT.agents[1] ?? null)).toBe("u/grace");
		expect(flairLabel(postById("thread-flaky"))).toBe("Run failed");
		expect(
			flairLabel({
				...postById("thread-flaky"),
				thread: { ...postById("thread-flaky").thread, runState: "interrupted" },
			})
		).toBe("Interrupted");
		expect(flairLabel(postById("thread-triage"))).toBe("Working");
		expect(flairLabel(postById("thread-intro"))).toBe("Waiting on agent");
	});

	test("keyboard steps clamp at the ends of the feed", () => {
		expect(stepPost([], null, 1)).toBeNull();
		expect(stepPost(["a", "b"], null, 1)).toBe("a");
		expect(stepPost(["a", "b"], null, -1)).toBe("b");
		expect(stepPost(["a", "b"], "b", 1)).toBe("b");
		expect(stepPost(["a", "b"], "b", -1)).toBe("a");
	});
});

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
		<CommunityInterface
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

function postIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("article[data-thread-id]")].map(
		(article) => article.getAttribute("data-thread-id") ?? ""
	);
}

function rootOf(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>(
		"[data-testid='interface-community']"
	);
	if (!root) {
		throw new Error("root missing");
	}
	return root;
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

describe("community interface", () => {
	test("renders the nav, sort tabs, and a Hot feed without a host", () => {
		const html = renderToStaticMarkup(
			<CommunityInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={{
					closeThread: () => undefined,
					openThread: () => undefined,
					startThread: () => undefined,
				}}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-community"');
		expect(html).toContain("r/SiteV2");
		expect(html).toContain("r/DocsCrew");
		expect(html).toContain("r/Ada");
		expect(html).toContain('role="tablist"');
		expect(html).toContain("Safari crash triage");
		expect(html).toContain("Run failed");
		expect(html).not.toContain("community-post-page");
	});

	test("shows a skeleton while loading and a plain empty state after", async () => {
		const loading = renderToStaticMarkup(
			<CommunityInterface
				activeThreadId={null}
				loading
				params={{}}
				port={{
					closeThread: () => undefined,
					openThread: () => undefined,
					startThread: () => undefined,
				}}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(loading).toContain("Loading posts");
		expect(loading).not.toContain("community-empty");

		const calls: string[] = [];
		const view = await mount(<Host calls={calls} snapshot={EMPTY} />);
		const empty = view.container.querySelector(
			"[data-testid='community-empty']"
		);
		expect(empty?.textContent).toContain("No posts yet");
		expect(empty?.textContent).toContain("Add an agent in Ryu");
		await click(buttonNamed(view.container, "Create post"));
		expect(
			view.container.querySelector("[data-testid='community-composer']")
		).not.toBeNull();
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("opening a post shows the host's conversation as its comments", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Safari crash triage"));
		expect(calls).toEqual(["open:thread-triage"]);
		const page = view.container.querySelector(
			"[data-testid='community-post-page']"
		);
		expect(page?.querySelector("h1")?.textContent).toBe("Safari crash triage");
		const comments = view.container.querySelector(
			"[data-testid='community-thread-view']"
		);
		expect(comments?.getAttribute("aria-label")).toBe("Comments");
		expect(comments?.textContent).toBe("chat for thread-triage");
		expect(
			view.container.querySelector("[data-testid='community-about']")
				?.textContent
		).toContain("Site v2!");
		await click(buttonNamed(view.container, "Back"));
		expect(calls).toEqual(["open:thread-triage", "close"]);
		expect(
			view.container.querySelector("[data-testid='community-feed']")
		).not.toBeNull();
		await view.dispose();
	});

	test("Escape leaves an open post", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-notes" />
		);
		await press(rootOf(view.container), "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("votes are local, toggle, and never reorder the feed", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const before = postIds(view.container);
		const up = buttonNamed(view.container, "Upvote “Release notes draft”");
		await click(up);
		const article = view.container.querySelector(
			"article[data-thread-id='thread-notes']"
		);
		expect(up.getAttribute("aria-pressed")).toBe("true");
		expect(article?.querySelector("[data-vote]")?.textContent).toContain("5");
		await click(buttonNamed(view.container, "Downvote “Release notes draft”"));
		expect(article?.querySelector("[data-vote]")?.textContent).toContain("3");
		await click(buttonNamed(view.container, "Downvote “Release notes draft”"));
		expect(article?.querySelector("[data-vote]")?.textContent).toContain("4");
		expect(postIds(view.container)).toEqual(before);
		await click(buttonNamed(view.container, "Save “Release notes draft”"));
		expect(
			buttonNamed(view.container, "Unsave “Release notes draft”").getAttribute(
				"aria-pressed"
			)
		).toBe("true");
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("sort tabs and the view switch change the feed", async () => {
		const view = await mount(<Host calls={[]} />);
		const tabs = [...view.container.querySelectorAll("[role='tab']")];
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Hot", "New", "Top"]);
		const newTab = tabs[1] as HTMLButtonElement;
		await click(newTab);
		expect(newTab.getAttribute("aria-selected")).toBe("true");
		expect(postIds(view.container)).toEqual(ids(sortPosts(POSTS, "new")));
		await press(newTab, "ArrowRight");
		expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
		expect(postIds(view.container)[0]).toBe("thread-flaky");
		await click(buttonNamed(view.container, "Compact view"));
		expect(
			view.container
				.querySelector("[data-testid='community-feed']")
				?.getAttribute("data-mode")
		).toBe("compact");
		await view.dispose();
	});

	test("a community page has a banner, an About card, and Message", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "r/Ada"));
		const header = view.container.querySelector(
			"[data-testid='community-header']"
		);
		expect(header?.querySelector("h1")?.textContent).toBe("r/Ada");
		expect(
			view.container.querySelector("[data-testid='community-banner']")
		).not.toBeNull();
		expect(postIds(view.container)).toEqual([
			"thread-flaky",
			"thread-notes",
			"thread-intro",
		]);
		const about = view.container.querySelector(
			"[data-testid='community-about']"
		);
		expect(about?.textContent).toContain("Writes the release notes");
		expect(about?.textContent).toContain("Members");
		expect(
			view.container
				.querySelector("button[aria-current='page']")
				?.textContent?.trim()
		).toBe("r/Ada");
		await click(buttonNamed(view.container, "Message Ada"));
		expect(calls).toEqual(['start:{"agentId":"agent-ada"}']);
		await view.dispose();
	});

	test("Create Post from a community files the typed post there", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "r/SiteV2"));
		await click(buttonNamed(view.container, "Create Post"));
		const form = view.container.querySelector(
			"[data-testid='community-composer']"
		);
		expect(
			view.container
				.querySelector("[data-testid='community-picker']")
				?.getAttribute("aria-label")
		).toBe("Community: r/SiteV2");
		const post = buttonNamed(view.container, "Post");
		expect(post.disabled).toBe(true);
		const title = form?.querySelector("input");
		const body = form?.querySelector("textarea");
		if (!(title && body)) {
			throw new Error("fields missing");
		}
		await typeInto(title, "Why does Safari crash?");
		await typeInto(body, "Only on iOS 18.");
		expect(form?.textContent).toContain("22/300");
		expect(post.disabled).toBe(false);
		expect(calls).toEqual([]);
		await click(post);
		expect(calls).toEqual([
			`start:${JSON.stringify({
				projectId: "project-site",
				prompt: "Why does Safari crash?\n\nOnly on iOS 18.",
			})}`,
		]);
		expect(
			view.container.querySelector("[data-testid='community-composer']")
		).toBeNull();
		await view.dispose();
	});

	test("search narrows across communities and offers to clear", async () => {
		const view = await mount(<Host calls={[]} />);
		const search = view.container.querySelector<HTMLInputElement>(
			"input[type='search']"
		);
		if (!search) {
			throw new Error("search missing");
		}
		await typeInto(search, "flaky");
		expect(postIds(view.container)).toEqual(["thread-flaky"]);
		expect(view.container.textContent).toContain("1 post for “flaky”");
		await typeInto(search, "zebra");
		expect(
			view.container.querySelector("[data-testid='community-empty']")
				?.textContent
		).toContain("No results for “zebra”");
		await click(buttonNamed(view.container, "Clear search"));
		expect(postIds(view.container)).toHaveLength(5);
		await view.dispose();
	});

	test("j and k walk the feed; posters open their agent's community", async () => {
		const view = await mount(<Host calls={[]} />);
		const root = rootOf(view.container);
		await press(root, "j");
		const first = postIds(view.container)[0];
		expect(
			document.activeElement?.closest("article")?.getAttribute("data-thread-id")
		).toBe(first);
		await press(root, "j");
		expect(
			document.activeElement?.closest("article")?.getAttribute("data-thread-id")
		).toBe(postIds(view.container)[1]);
		await click(buttonNamed(view.container, "Open u/grace"));
		expect(
			view.container.querySelector("[data-testid='community-header'] h1")
				?.textContent
		).toBe("r/Grace");
		await click(buttonNamed(view.container, "Popular"));
		expect(postIds(view.container)).toHaveLength(3);
		await view.dispose();
	});
});
