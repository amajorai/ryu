import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QaInterface } from "./qa-interface.tsx";
import {
	EMPTY_QA_FILTER,
	emptyQaDraft,
	qaAllQuestions,
	qaAnswerCount,
	qaFeed,
	qaHeading,
	qaMatches,
	qaNames,
	qaPrompt,
	qaQuestion,
	qaRelated,
	qaStartInput,
	qaStep,
	qaTabCounts,
	qaTopAnswerers,
	qaTopicCounts,
} from "./qa-model.ts";

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
			description: "Never answered",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
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
			title: "How should the release notes open?",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			messageCount: 3,
			title: "Is the intro too long?",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 2,
			projectId: "project-site",
			running: true,
			title: "Why does the site crash on Safari?",
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
			title: "Which test is flaky?",
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
		<QaInterface
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

function tabNamed(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [
		...container.querySelectorAll<HTMLButtonElement>("[role='tab']"),
	].find((tab) => tab.id.endsWith(label));
	if (!match) {
		throw new Error(`No tab ${label}`);
	}
	return match;
}

function rowIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("article[data-thread-id]")].map(
		(article) => article.getAttribute("data-thread-id") ?? ""
	);
}

function rootOf(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>(
		"[data-testid='interface-qa']"
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

describe("qa model", () => {
	test("counts agent replies from the alternating message count", () => {
		expect(qaAnswerCount(thread({ id: "a", messageCount: 0 }))).toBe(0);
		expect(qaAnswerCount(thread({ id: "b", messageCount: 4 }))).toBe(2);
		expect(qaAnswerCount(thread({ id: "c", messageCount: 1 }))).toBe(1);
		expect(
			qaAnswerCount(
				thread({ id: "d", lastMessageRole: "user", messageCount: 3 })
			)
		).toBe(1);
		expect(
			qaAnswerCount(
				thread({ id: "e", lastMessageRole: "user", messageCount: 1 })
			)
		).toBe(0);
	});

	test("bylines follow the thread status", () => {
		const bylines = qaAllQuestions(SNAPSHOT).map((question) => [
			question.thread.id,
			question.byline,
		]);
		expect(bylines).toEqual([
			["thread-notes", "answered"],
			["thread-intro", "asked"],
			["thread-triage", "answering"],
			["thread-flaky", "failed"],
			["thread-loose", "unasked"],
		]);
	});

	test("tags come from the thread's project, then its team", () => {
		const flaky = SNAPSHOT.threads.find((item) => item.id === "thread-flaky");
		if (!flaky) {
			throw new Error("fixture missing");
		}
		expect(
			qaQuestion(SNAPSHOT, flaky).topics.map((topic) => topic.name)
		).toEqual(["Site", "Docs Crew"]);
	});

	test("Top keeps pinned questions first, then the most recent", () => {
		const feed = qaFeed(qaAllQuestions(SNAPSHOT), EMPTY_QA_FILTER);
		expect(feed.map((question) => question.thread.id)).toEqual([
			"thread-loose",
			"thread-triage",
			"thread-notes",
			"thread-intro",
			"thread-flaky",
		]);
	});

	test("tabs split by status and leave live runs under Top only", () => {
		const questions = qaAllQuestions(SNAPSHOT);
		const ids = (tab: typeof EMPTY_QA_FILTER.tab) =>
			qaFeed(questions, { ...EMPTY_QA_FILTER, tab }).map(
				(question) => question.thread.id
			);
		expect(ids("unanswered")).toEqual(["thread-intro", "thread-loose"]);
		expect(ids("answered")).toEqual(["thread-notes"]);
		expect(ids("attention")).toEqual(["thread-flaky"]);
		expect(qaTabCounts(questions, EMPTY_QA_FILTER)).toEqual({
			answered: 1,
			attention: 1,
			top: 5,
			unanswered: 2,
		});
	});

	test("topic, answerer, and search narrow the feed together", () => {
		const questions = qaAllQuestions(SNAPSHOT);
		const ids = (filter: Partial<typeof EMPTY_QA_FILTER>) =>
			qaFeed(questions, { ...EMPTY_QA_FILTER, ...filter }).map(
				(question) => question.thread.id
			);
		expect(ids({ topicId: "project-site" })).toEqual([
			"thread-triage",
			"thread-flaky",
		]);
		expect(ids({ agentId: "agent-ada", topicId: "team-docs" })).toEqual([
			"thread-notes",
			"thread-flaky",
		]);
		expect(ids({ query: "safari crash" })).toEqual(["thread-triage"]);
		expect(ids({ query: "grace" })).toEqual(["thread-triage", "thread-flaky"]);
		expect(ids({ query: "docs crew flaky" })).toEqual(["thread-flaky"]);
		const [first] = questions;
		if (!first) {
			throw new Error("fixture missing");
		}
		expect(qaMatches(first, "")).toBe(true);
	});

	test("top answerers rank by replies and skip agents with none", () => {
		expect(
			qaTopAnswerers(SNAPSHOT).map((entry) => [entry.agent.name, entry.answers])
		).toEqual([
			["Ada", 6],
			["Grace", 4],
		]);
	});

	test("topics list how many questions carry each, busiest first", () => {
		expect(
			qaTopicCounts(SNAPSHOT).map((entry) => [entry.topic.name, entry.count])
		).toEqual([
			["Docs Crew", 2],
			["Site", 2],
		]);
	});

	test("related questions share an agent or topic, closest then newest first", () => {
		expect(
			qaRelated(SNAPSHOT, "thread-flaky").map((question) => question.thread.id)
		).toEqual(["thread-triage", "thread-notes", "thread-intro"]);
		expect(qaRelated(SNAPSHOT, "thread-loose")).toEqual([]);
		expect(qaRelated(SNAPSHOT, "missing")).toEqual([]);
	});

	test("a draft becomes one prompt filed under its topic and agent", () => {
		expect(qaPrompt({ ...emptyQaDraft(), title: "   " })).toBe("");
		expect(
			qaStartInput({ ...emptyQaDraft(), body: "details" }, SNAPSHOT)
		).toBeNull();
		expect(
			qaStartInput(
				{
					agentId: "agent-grace",
					body: "  It only happens on iOS.  ",
					title: " Why does Safari crash? ",
					topicId: "project-site",
				},
				SNAPSHOT
			)
		).toEqual({
			agentId: "agent-grace",
			projectId: "project-site",
			prompt: "Why does Safari crash?\n\nIt only happens on iOS.",
		});
		expect(
			qaStartInput(
				{
					agentId: "agent-gone",
					body: "",
					title: "Docs?",
					topicId: "team-docs",
				},
				SNAPSHOT
			)
		).toEqual({ prompt: "Docs?", teamId: "team-docs" });
	});

	test("new drafts start in the current topic and with the current agent", () => {
		expect(
			emptyQaDraft({
				...EMPTY_QA_FILTER,
				agentId: "agent-ada",
				topicId: "team-docs",
			})
		).toEqual({
			agentId: "agent-ada",
			body: "",
			title: "",
			topicId: "team-docs",
		});
	});

	test("headings and names read the way Stack Overflow and Quora say them", () => {
		expect(qaHeading(SNAPSHOT, EMPTY_QA_FILTER)).toBe("Top questions");
		expect(
			qaHeading(SNAPSHOT, { ...EMPTY_QA_FILTER, topicId: "project-site" })
		).toBe("Questions in Site");
		expect(
			qaHeading(SNAPSHOT, { ...EMPTY_QA_FILTER, agentId: "agent-ada" })
		).toBe("Questions for Ada");
		expect(qaHeading(SNAPSHOT, { ...EMPTY_QA_FILTER, query: "x" })).toBe(
			"Search results"
		);
		const [ada, grace, linus] = SNAPSHOT.agents;
		if (!(ada && grace && linus)) {
			throw new Error("fixture missing");
		}
		expect(qaNames([ada])).toBe("Ada");
		expect(qaNames([ada, grace])).toBe("Ada and Grace");
		expect(qaNames([ada, grace, linus])).toBe("Ada and 2 others");
	});

	test("steps through the feed and clamps at the ends", () => {
		const order = ["a", "b", "c"];
		expect(qaStep(order, null, 1)).toBe("a");
		expect(qaStep(order, null, -1)).toBe("c");
		expect(qaStep(order, "b", 1)).toBe("c");
		expect(qaStep(order, "c", 1)).toBe("c");
		expect(qaStep(order, "a", -1)).toBe("a");
		expect(qaStep([], null, 1)).toBeNull();
	});
});

describe("QaInterface markup", () => {
	test("renders the header, tabs, question rows, and the rail", () => {
		const markup = renderToStaticMarkup(<Host calls={[]} />);
		expect(markup).toContain('data-testid="interface-qa"');
		expect(markup).toContain('aria-label="Search questions"');
		expect(markup).toContain("Ask question");
		expect(markup).toContain("Top questions");
		expect(markup).toContain('role="tablist"');
		expect(markup).toContain("Needs attention");
		expect(markup).toContain("How should the release notes open?");
		expect(markup).toContain("answered");
		expect(markup).toContain("is answering");
		expect(markup).toContain("run failed");
		expect(markup).toContain("Waiting on Ada");
		expect(markup).toContain("Top answerers");
		expect(markup).toContain("Docs Crew");
	});

	test("shows a skeleton while the first snapshot loads", () => {
		const markup = renderToStaticMarkup(
			<QaInterface
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
		expect(markup).toContain('aria-label="Loading questions"');
		expect(markup).not.toContain("No questions yet");
	});

	test("an empty workspace explains questions and offers Ask question", () => {
		const markup = renderToStaticMarkup(<Host calls={[]} snapshot={EMPTY} />);
		expect(markup).toContain("No questions yet");
		expect(markup).toContain("Add an agent in Ryu");
		expect(markup).toContain("Agents show up here once they answer.");
	});
});

describe("QaInterface interactions", () => {
	test("opening a question shows the host chat as its answers", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(
			buttonNamed(view.container, "How should the release notes open?")
		);
		expect(calls).toEqual(["open:thread-notes"]);
		const page = view.container.querySelector("[data-testid='qa-page']");
		expect(page?.querySelector("h1")?.textContent).toBe(
			"How should the release notes open?"
		);
		expect(
			view.container.querySelector(
				"[data-testid='qa-thread-view'] [data-testid='host-chat']"
			)?.textContent
		).toBe("chat for thread-notes");
		const related = view.container.querySelector("[data-testid='qa-related']");
		expect(related?.textContent).toContain("Which test is flaky?");
		await click(buttonNamed(view.container, "Which test is flaky?"));
		expect(calls).toEqual(["open:thread-notes", "open:thread-flaky"]);
		await click(buttonNamed(view.container, "All questions"));
		expect(calls.at(-1)).toBe("close");
		expect(view.container.querySelector("[data-testid='qa-page']")).toBeNull();
		await view.dispose();
	});

	test("Escape leaves an open question", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-flaky" />
		);
		const page = view.container.querySelector("[data-testid='qa-page']");
		if (!page) {
			throw new Error("question page missing");
		}
		expect(page.textContent).toContain("Needs attention");
		await press(page, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("tabs, tags, and answerers narrow the feed", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(tabNamed(view.container, "unanswered"));
		expect(rowIds(view.container)).toEqual(["thread-intro", "thread-loose"]);
		expect(
			tabNamed(view.container, "unanswered").getAttribute("aria-selected")
		).toBe("true");
		await press(tabNamed(view.container, "unanswered"), "ArrowRight");
		expect(rowIds(view.container)).toEqual(["thread-notes"]);
		await click(tabNamed(view.container, "top"));
		const tags = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"article button[aria-label='Show questions in Site']"
			),
		];
		const siteTag = tags[0];
		if (!siteTag) {
			throw new Error("tag missing");
		}
		await click(siteTag);
		expect(view.container.querySelector("h1")?.textContent).toBe(
			"Questions in Site"
		);
		expect(rowIds(view.container)).toEqual(["thread-triage", "thread-flaky"]);
		await click(buttonNamed(view.container, "All questions"));
		expect(rowIds(view.container)).toHaveLength(5);
		await click(buttonNamed(view.container, "Grace, 4 answers, working"));
		expect(view.container.querySelector("h1")?.textContent).toBe(
			"Questions for Grace"
		);
		expect(rowIds(view.container)).toEqual(["thread-triage", "thread-flaky"]);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("search filters as you type and says when nothing matches", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await press(rootOf(view.container), "/");
		const search = view.container.querySelector<HTMLInputElement>(
			"input[aria-label='Search questions']"
		);
		if (!search) {
			throw new Error("search missing");
		}
		expect(document.activeElement).toBe(search);
		await typeInto(search, "safari");
		expect(rowIds(view.container)).toEqual(["thread-triage"]);
		expect(view.container.textContent).toContain("1 result for “safari”");
		await typeInto(search, "kubernetes");
		expect(
			view.container.querySelector("[data-testid='qa-empty']")?.textContent
		).toContain("No results for “kubernetes”");
		await click(buttonNamed(view.container, "Clear search"));
		expect(rowIds(view.container)).toHaveLength(5);
		await view.dispose();
	});

	test("asking sends the question and details through the port", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Ask question"));
		const form = view.container.querySelector("[data-testid='qa-ask']");
		const title = form?.querySelector("input");
		const body = form?.querySelector("textarea");
		if (!(title && body)) {
			throw new Error("ask form missing");
		}
		expect(document.activeElement).toBe(title);
		const post = buttonNamed(view.container, "Post your question");
		expect(post.disabled).toBe(true);
		await typeInto(title, "Why is CI slow?");
		await typeInto(body, "It doubled last week.");
		await click(buttonNamed(view.container, "Post your question"));
		expect(calls).toEqual([
			`start:${JSON.stringify({ prompt: "Why is CI slow?\n\nIt doubled last week." })}`,
		]);
		expect(view.container.querySelector("[data-testid='qa-ask']")).toBeNull();
		await view.dispose();
	});

	test("an empty question never sends, and Escape discards the form", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(buttonNamed(view.container, "Ask question"));
		const title = view.container.querySelector<HTMLInputElement>(
			"[data-testid='qa-ask'] input"
		);
		if (!title) {
			throw new Error("ask form missing");
		}
		await press(title, "Enter", { metaKey: true });
		expect(calls).toEqual([]);
		await press(title, "Escape");
		expect(view.container.querySelector("[data-testid='qa-ask']")).toBeNull();
		await view.dispose();
	});

	test("j and k move focus between questions", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const root = rootOf(view.container);
		await press(root, "j");
		expect(document.activeElement?.textContent).toBe("Loose ends");
		await press(document.activeElement ?? root, "j");
		expect(document.activeElement?.textContent).toBe(
			"Why does the site crash on Safari?"
		);
		await press(document.activeElement ?? root, "k");
		expect(document.activeElement?.textContent).toBe("Loose ends");
		await view.dispose();
	});
});
