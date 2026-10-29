import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { WikiInterface } from "./wiki-interface.tsx";
import {
	agentLeadActivity,
	agentLeadIntro,
	categoryLetters,
	changesByDay,
	DEFAULT_THREAD_SORT,
	didYouKnow,
	eventsOnDay,
	excerptAround,
	featuredAgent,
	groupLead,
	indexEntries,
	markMatches,
	newsItem,
	nextSort,
	segmentsText,
	sortThreads,
	threadLead,
	threadRevisions,
	wikiAgentArticle,
	wikiAgo,
	wikiGroupArticle,
	wikiPageHeading,
	wikiSearch,
	wikiSuggest,
	wikiThreadArticle,
} from "./wiki-model.ts";

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

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-grace",
		end: ago(29),
		id: "event-triage",
		kind: "past",
		label: "Daily at noon",
		outcome: "failure",
		start: ago(30),
		title: "Bug triage",
	},
	{
		agentId: "agent-grace",
		id: "event-triage-next",
		kind: "upcoming",
		label: "Daily at noon",
		start: new Date(BASE + 60 * MINUTE).toISOString(),
		title: "Bug triage",
	},
];

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
			description: "",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: EVENTS,
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
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			messageCount: 3,
			title: "Shorter intro",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 2,
			projectId: "project-site",
			running: true,
			title: "Safari crash",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace", "agent-ada"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			messageCount: 6,
			projectId: "project-site",
			runState: "failed",
			teamId: "team-docs",
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
			updatedAt: ago(60 * 30),
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
		<WikiInterface
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
				startThread: (input) => {
					calls.push(`start:${JSON.stringify(input)}`);
				},
			}}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

function heading(container: HTMLElement): string {
	return container.querySelector("h1")?.textContent ?? "";
}

function link(container: HTMLElement, name: string): HTMLAnchorElement {
	const found = [...container.querySelectorAll("a")].find(
		(anchor) => anchor.textContent === name
	);
	if (!found) {
		throw new Error(`No link named ${name}`);
	}
	return found;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(
		(element) =>
			element.textContent === name ||
			element.getAttribute("aria-label") === name
	);
	if (!found) {
		throw new Error(`No button named ${name}`);
	}
	return found;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true })
		);
	});
}

async function typeInto(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		element.focus();
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		// react-dom loads before the DOM is registered, so it listens for the
		// legacy keyup path instead of `input`.
		element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

async function press(element: HTMLElement, key: string) {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

describe("wiki model", () => {
	test("builds an agent article with threads, groups and collaborators", () => {
		const article = wikiAgentArticle(SNAPSHOT, "agent-ada");
		expect(article?.threads.map((item) => item.id)).toEqual([
			"thread-notes",
			"thread-intro",
			"thread-flaky",
		]);
		expect(article?.teams.map((group) => group.id)).toEqual(["team-docs"]);
		// Ada is not a member of Site, but files a thread there.
		expect(article?.projects.map((group) => group.id)).toEqual([
			"project-site",
		]);
		expect(article?.messages).toBe(13);
		expect(
			article?.collaborators.map((entry) => [
				entry.agent.name,
				entry.shared,
				entry.sharedGroups,
			])
		).toEqual([
			["Grace", 1, 0],
			["Linus", 0, 1],
		]);
		expect(wikiAgentArticle(SNAPSHOT, "agent-missing")).toBeNull();
	});

	test("writes the agent lead from the description and live counts", () => {
		const article = wikiAgentArticle(SNAPSHOT, "agent-ada");
		if (!article) {
			throw new Error("missing article");
		}
		expect(segmentsText(agentLeadIntro(article))).toBe(
			"Ada is an agent in this workspace, described as “writes the release notes”. It is a member of the Docs Crew team."
		);
		expect(segmentsText(agentLeadActivity(article, BASE))).toBe(
			"Ada has taken part in 3 threads, with 13 messages in all. Its most recent is Release notes, updated 30 minutes ago. Right now, 1 of its threads is waiting on your reply and 1 of its threads needs attention after a stopped run."
		);
		const linus = wikiAgentArticle(SNAPSHOT, "agent-linus");
		if (!linus) {
			throw new Error("missing article");
		}
		expect(segmentsText(agentLeadIntro(linus))).toBe(
			"Linus is an agent in this workspace. It is a member of the Docs Crew team."
		);
		expect(segmentsText(agentLeadActivity(linus, BASE))).toContain(
			"has not taken part in any threads yet"
		);
	});

	test("writes team and thread leads with links to their pages", () => {
		const group = wikiGroupArticle(SNAPSHOT, "team-docs");
		if (!group) {
			throw new Error("missing group");
		}
		const lead = groupLead(group, BASE);
		expect(segmentsText(lead)).toBe(
			"Docs Crew is a team in this workspace made up of 2 agents: Ada and Linus. Its 2 threads hold 10 messages; the most recent is Release notes, updated 30 minutes ago."
		);
		expect(
			lead.filter((segment) => segment.kind === "link").map((s) => s.text)
		).toEqual(["Ada", "Linus", "Release notes"]);

		const flaky = wikiThreadArticle(SNAPSHOT, "thread-flaky");
		if (!flaky) {
			throw new Error("missing thread");
		}
		expect(segmentsText(threadLead(flaky, BASE))).toBe(
			"Flaky test is a thread in the Site project with Grace and Ada. It has 6 messages and was last updated 2 hours ago. The thread needs attention after its last run stopped."
		);
		expect(flaky.related.map((item) => item.id)).toEqual([
			"thread-triage",
			"thread-notes",
			"thread-intro",
		]);
	});

	test("formats relative times without off-by-rounding units", () => {
		expect(wikiAgo(ago(0), BASE)).toBe("just now");
		expect(wikiAgo(ago(5), BASE)).toBe("5 minutes ago");
		expect(wikiAgo(ago(60 * 26), BASE)).toBe("yesterday");
		// 59.99 minutes ahead rounds up to an hour, never "60 minutes".
		expect(wikiAgo(new Date(BASE + 3_599_500).toISOString(), BASE)).toBe(
			"in 1 hour"
		);
		expect(wikiAgo("not a date", BASE)).toBe("at an unknown time");
	});

	test("suggests title prefixes and searches bodies", () => {
		expect(wikiSuggest(SNAPSHOT, "re").map((entry) => entry.title)).toEqual([
			"Release notes",
		]);
		// "crash" starts a title word; "ash" does not.
		expect(wikiSuggest(SNAPSHOT, "crash").map((entry) => entry.id)).toEqual([
			"thread-triage",
		]);
		expect(wikiSuggest(SNAPSHOT, "ash")).toEqual([]);
		const hits = wikiSearch(SNAPSHOT, "crash");
		expect(hits[0]?.entry.id).toBe("thread-triage");
		expect(wikiSearch(SNAPSHOT, "bugs").map((hit) => hit.entry.id)).toEqual([
			"agent-grace",
		]);
		expect(wikiSearch(SNAPSHOT, "   ")).toEqual([]);
	});

	test("marks matches and excerpts around them", () => {
		expect(markMatches("Release notes", "note")).toEqual([
			{ match: false, text: "Release " },
			{ match: true, text: "note" },
			{ match: false, text: "s" },
		]);
		expect(markMatches("a.b", ".")).toEqual([
			{ match: false, text: "a" },
			{ match: true, text: "." },
			{ match: false, text: "b" },
		]);
		const long = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
		const excerpt = excerptAround(long, "needle", 20);
		expect(excerpt.startsWith("…")).toBe(true);
		expect(excerpt.endsWith("…")).toBe(true);
		expect(excerpt).toContain("needle");
	});

	test("sorts the List of threads like a wikitable", () => {
		const titles = (sort: typeof DEFAULT_THREAD_SORT) =>
			sortThreads(SNAPSHOT, SNAPSHOT.threads, sort).map((item) => item.title);
		expect(titles(DEFAULT_THREAD_SORT)[0]).toBe("Safari crash");
		expect(titles({ direction: "ascending", key: "title" })).toEqual([
			"Flaky test",
			"Loose ends",
			"Release notes",
			"Safari crash",
			"Shorter intro",
		]);
		expect(titles({ direction: "ascending", key: "status" })[0]).toBe(
			"Flaky test"
		);
		expect(nextSort(DEFAULT_THREAD_SORT, "updated").direction).toBe(
			"ascending"
		);
		expect(nextSort(DEFAULT_THREAD_SORT, "title")).toEqual({
			direction: "ascending",
			key: "title",
		});
		expect(nextSort(DEFAULT_THREAD_SORT, "messages").direction).toBe(
			"descending"
		);
	});

	test("groups category pages by initial and changes by day", () => {
		const letters = categoryLetters(indexEntries(SNAPSHOT, "agents"));
		expect(letters.map((group) => group.letter)).toEqual(["A", "G", "L"]);
		const days = changesByDay(threadRevisions(SNAPSHOT.threads));
		expect(days.at(-1)?.revisions.map((row) => row.at)).toEqual([ago(60 * 30)]);
		expect(days.reduce((sum, day) => sum + day.revisions.length, 0)).toBe(5);
	});

	test("fills the main page from the snapshot", () => {
		expect(featuredAgent(SNAPSHOT)?.agent.name).toBe("Ada");
		expect(featuredAgent(EMPTY)).toBeNull();
		const news = SNAPSHOT.threads.map((item) =>
			segmentsText(newsItem(SNAPSHOT, item))
		);
		expect(news).toEqual([
			"Ada replied in Release notes.",
			"You asked Ada a follow-up in Shorter intro.",
			"Grace is working on Safari crash.",
			"A run stopped in Flaky test and needs attention.",
			"Loose ends was opened.",
		]);
		const facts = didYouKnow(SNAPSHOT).map(segmentsText);
		expect(facts[0]).toBe(
			"... that Ada has taken part in 3 threads, more than any other agent?"
		);
		expect(facts).toContain("... that 1 run is live right now?");
		expect(didYouKnow(EMPTY)).toEqual([]);
		const today = eventsOnDay(SNAPSHOT, BASE).map((item) => item.event.id);
		expect(today).toContain("event-triage");
	});

	test("names pages the way the reference does", () => {
		expect(
			wikiPageHeading(SNAPSHOT, { id: "agent-ada", kind: "agent" }, "talk")
		).toBe("Talk:Ada");
		expect(
			wikiPageHeading(SNAPSHOT, { id: "team-docs", kind: "group" }, "history")
		).toBe("Docs Crew: Revision history");
		expect(
			wikiPageHeading(SNAPSHOT, { index: "teams", kind: "index" }, "article")
		).toBe("Category:Teams");
		expect(
			wikiPageHeading(SNAPSHOT, { index: "threads", kind: "index" }, "talk")
		).toBe("List of threads");
	});
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

describe("WikiInterface", () => {
	test("renders the main page on the server", () => {
		const markup = renderToStaticMarkup(<Host calls={[]} />);
		expect(markup).toContain('data-testid="interface-wiki"');
		expect(markup).toContain("Welcome to the wiki,");
		expect(markup).toContain("From today’s featured article");
		expect(markup).toContain("In the news");
		expect(markup).toContain("Did you know ...");
		expect(markup).toContain('aria-label="Main menu"');
	});

	test("shows a loading skeleton, then an empty wiki that can start a thread", async () => {
		const loadingMarkup = renderToStaticMarkup(
			<Host calls={[]} loading snapshot={EMPTY} />
		);
		expect(loadingMarkup).toContain('role="status"');
		expect(loadingMarkup).toContain("Loading the wiki");

		const calls: string[] = [];
		const view = await mount(<Host calls={calls} snapshot={EMPTY} />);
		expect(view.container.textContent).toContain("This wiki has no pages yet");
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("missing composer");
		}
		await click(button(view.container, "Start thread"));
		expect(calls).toEqual([]);
		await typeInto(field, "  Plan the launch  ");
		await click(button(view.container, "Start thread"));
		expect(calls).toEqual(['start:{"prompt":"Plan the launch"}']);
		await view.dispose();
	});

	test("navigates by wiki links into an agent article", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(link(view.container, "Agents"));
		expect(heading(view.container)).toBe("Category:Agents");
		await click(link(view.container, "Grace"));
		expect(heading(view.container)).toBe("Grace");
		expect(view.container.textContent).toContain("From the workspace wiki");
		const infobox = view.container.querySelector(
			'aside[aria-label="Grace summary"]'
		);
		expect(infobox?.textContent).toContain("Working");
		expect(infobox?.textContent).toContain("Bug triage");
		const toc = view.container.querySelector('nav[aria-label="Contents"]');
		expect(toc?.textContent).toContain("Scheduled runs");
		expect(
			link(view.container, "Agents").getAttribute("aria-current")
		).toBeNull();
		// Following a link never touches the host chat.
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("a thread's Talk tab is the host conversation", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(link(view.container, "Threads"));
		expect(heading(view.container)).toBe("List of threads");
		await click(link(view.container, "Safari crash"));
		expect(heading(view.container)).toBe("Safari crash");
		expect(
			view.container.querySelector('[data-testid="host-chat"]')
		).toBeNull();

		await click(button(view.container, "Talk"));
		expect(calls).toEqual(["open:thread-triage"]);
		expect(heading(view.container)).toBe("Talk:Safari crash");
		expect(
			view.container.querySelector('[data-testid="host-chat"]')?.textContent
		).toBe("chat for thread-triage");

		await click(button(view.container, "Article"));
		expect(calls).toEqual(["open:thread-triage", "close"]);
		expect(heading(view.container)).toBe("Safari crash");
		await view.dispose();
	});

	test("opens on the Talk page when the host already has a thread open", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-flaky" />
		);
		expect(heading(view.container)).toBe("Talk:Flaky test");
		expect(view.container.textContent).toContain("chat for thread-flaky");
		await click(link(view.container, "Main page"));
		expect(calls).toEqual(["close"]);
		expect(view.container.textContent).toContain("Welcome to the wiki,");
		await view.dispose();
	});

	test("adds a topic on an agent's or a team's talk page", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(link(view.container, "Agents"));
		await click(link(view.container, "Ada"));
		await click(button(view.container, "Talk"));
		expect(heading(view.container)).toBe("Talk:Ada");
		expect(view.container.textContent).toContain("Shorter intro");
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("missing composer");
		}
		await typeInto(field, "Draft the FAQ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-ada","prompt":"Draft the FAQ"}',
		]);

		await click(link(view.container, "Teams"));
		await click(link(view.container, "Docs Crew"));
		await click(button(view.container, "Talk"));
		const teamField = view.container.querySelector("textarea");
		if (!teamField) {
			throw new Error("missing composer");
		}
		await typeInto(teamField, "Plan the docs sprint");
		await click(button(view.container, "Add topic"));
		expect(calls.at(-1)).toBe(
			'start:{"prompt":"Plan the docs sprint","teamId":"team-docs"}'
		);
		// Topics on a talk page open their thread through the port.
		await click(button(view.container, "Release notes"));
		expect(calls.at(-1)).toBe("open:thread-notes");
		await view.dispose();
	});

	test("searches with a typeahead and a results page", async () => {
		const view = await mount(<Host calls={[]} />);
		const input = view.container.querySelector<HTMLInputElement>(
			'input[role="combobox"]'
		);
		if (!input) {
			throw new Error("missing search");
		}
		await typeInto(input, "saf");
		const options = view.container.querySelectorAll('[role="option"]');
		expect(options.length).toBe(2);
		expect(options[0]?.textContent).toContain("Safari crash");
		expect(input.getAttribute("aria-expanded")).toBe("true");
		await press(input, "ArrowDown");
		expect(input.getAttribute("aria-activedescendant")).toBe(
			options[0]?.id ?? "missing"
		);
		const form = input.closest("form");
		await act(async () => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(heading(view.container)).toBe("Safari crash");

		await typeInto(input, "review");
		await act(async () => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(heading(view.container)).toBe("Search results");
		expect(view.container.textContent).toContain("Showing the only result");
		expect(link(view.container, "Release notes")).toBeDefined();
		await view.dispose();
	});

	test("sorts the List of threads from its column headings", async () => {
		const view = await mount(<Host calls={[]} />);
		await click(link(view.container, "Threads"));
		const header = () =>
			[...view.container.querySelectorAll("th")].find((cell) =>
				cell.textContent?.startsWith("Thread")
			);
		expect(header()?.getAttribute("aria-sort")).toBe("none");
		await click(button(view.container, "Thread"));
		expect(header()?.getAttribute("aria-sort")).toBe("ascending");
		const firstRow = view.container.querySelector("tbody tr");
		expect(firstRow?.textContent).toContain("Flaky test");
		await view.dispose();
	});

	test("shows revision history and recent changes", async () => {
		const view = await mount(<Host calls={[]} />);
		await click(link(view.container, "Agents"));
		await click(link(view.container, "Grace"));
		await click(button(view.container, "View history"));
		expect(heading(view.container)).toBe("Grace: Revision history");
		expect(view.container.textContent).toContain("(scheduled run, failed)");
		expect(view.container.textContent).toContain("Safari crash");
		await click(link(view.container, "Recent changes"));
		expect(heading(view.container)).toBe("Recent changes");
		expect(view.container.querySelectorAll("section li").length).toBe(5);
		await view.dispose();
	});

	test("collapses the table of contents and the pinned main menu", async () => {
		const view = await mount(<Host calls={[]} />);
		await click(link(view.container, "Agents"));
		await click(link(view.container, "Ada"));
		const toc = () =>
			view.container.querySelector('nav[aria-label="Contents"] ol');
		expect(toc()).not.toBeNull();
		await click(button(view.container, "Hide contents"));
		expect(button(view.container, "Show contents")).toBeDefined();

		await click(button(view.container, "hide"));
		const menuButton = button(view.container, "Main menu");
		expect(menuButton.getAttribute("aria-expanded")).toBe("false");
		await click(menuButton);
		expect(menuButton.getAttribute("aria-expanded")).toBe("true");
		await click(button(view.container, "move to sidebar"));
		expect(
			[...view.container.querySelectorAll("button")].some(
				(element) => element.getAttribute("aria-label") === "Main menu"
			)
		).toBe(false);
		await view.dispose();
	});
});
