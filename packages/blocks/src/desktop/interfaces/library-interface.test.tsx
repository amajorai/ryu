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
import { LibraryInterface } from "./library-interface.tsx";
import {
	agentBookId,
	agentBooks,
	authorList,
	COVER_LAYOUTS,
	collectionBooks,
	continueReading,
	coverSpec,
	findBook,
	groupBookId,
	libraryShelves,
	matchesQuery,
	neighbours,
	primaryBookId,
	progressLabel,
	progressPercent,
	readableAge,
	readingBook,
	resumeChapter,
	sortBooks,
	UNASSIGNED_BOOK_ID,
	viewBooks,
} from "./library-model.ts";

const MINUTE = 60_000;
const BASE = Date.now();
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
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
		{
			id: "team-core",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Core",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-site",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-style",
			lastMessage: "Style guide is done.",
			title: "Style guide",
			updatedAt: ago(60 * 30),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-plan",
			lastMessage: "Plan locked.",
			teamId: "team-core",
			title: "Quarter plan",
			updatedAt: ago(15),
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

function buttonByLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

function buttonStartingWith(container: HTMLElement, prefix: string) {
	return [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.getAttribute("aria-label") ?? "").startsWith(prefix)
	);
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

function view(
	overrides: Partial<Parameters<typeof LibraryInterface>[0]> = {}
): ReactElement {
	const { port } = recordingPort();
	return (
		<LibraryInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

async function typeInto(
	field: HTMLTextAreaElement | HTMLInputElement,
	text: string
) {
	// happy-dom keeps the value setter further up the prototype chain.
	let proto: object | null = Object.getPrototypeOf(field);
	let setValue: ((this: Element, next: string) => void) | undefined;
	while (proto && !setValue) {
		setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		field.focus();
		setValue?.call(field, text);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// react-dom loads before the DOM is registered, so it listens for the
		// legacy keyup path instead of `input`.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

describe("library model", () => {
	test("every agent is a book whose chapters run oldest first", () => {
		const books = agentBooks(SNAPSHOT);
		expect(books.map((book) => book.title)).toEqual(["Ada", "Grace", "Linus"]);
		const [ada, grace, linus] = books;
		expect(ada?.chapters.map((chapter) => chapter.thread.id)).toEqual([
			"thread-style",
			"thread-intro",
			"thread-notes",
			"thread-plan",
		]);
		expect(ada?.chapters.map((chapter) => chapter.number)).toEqual([
			1, 2, 3, 4,
		]);
		// Finished = the agent answered and nothing runs or failed.
		expect(ada?.finishedCount).toBe(3);
		expect(ada ? progressPercent(ada) : -1).toBe(75);
		expect(ada ? progressLabel(ada) : "").toBe("3 of 4 chapters finished");
		expect(grace?.working).toBe(true);
		expect(grace?.waiting.map((chapter) => chapter.status)).toEqual([
			"attention",
			"your-turn",
		]);
		expect(linus?.chapters).toHaveLength(0);
		expect(linus ? progressLabel(linus) : "").toBe("No chapters yet");
	});

	test("projects, teams and loose conversations become collections", () => {
		const collections = collectionBooks(SNAPSHOT);
		expect(collections.map((book) => [book.id, book.title])).toEqual([
			["project:project-site", "Website"],
			["team:team-core", "Core"],
			[UNASSIGNED_BOOK_ID, "Unassigned"],
		]);
		expect(collections[0]?.chapters.map((c) => c.thread.id)).toEqual([
			"thread-notes",
		]);
		expect(collections[1]?.authors.map((agent) => agent.name)).toEqual([
			"Ada",
			"Grace",
		]);
		expect(collections[2]?.chapters.map((c) => c.thread.id)).toEqual([
			"thread-loose",
		]);
		expect(
			collectionBooks({ ...SNAPSHOT, threads: [] }).some(
				(book) => book.id === UNASSIGNED_BOOK_ID
			)
		).toBe(false);
	});

	test("a conversation is shelved once: team, sole agent, project, first agent", () => {
		const byId = (id: string) =>
			SNAPSHOT.threads.find((item) => item.id === id) ?? thread({ id });
		expect(primaryBookId(byId("thread-plan"))).toBe("team:team-core");
		expect(primaryBookId(byId("thread-notes"))).toBe("agent:agent-ada");
		expect(
			primaryBookId(
				thread({
					agentIds: ["agent-ada", "agent-grace"],
					id: "x",
					projectId: "project-site",
				})
			)
		).toBe("project:project-site");
		expect(primaryBookId(byId("thread-loose"))).toBe(UNASSIGNED_BOOK_ID);
	});

	test("Continue Reading lists each waiting book once, failures first", () => {
		const items = continueReading(libraryShelves(SNAPSHOT));
		expect(
			items.map((item) => [item.book.id, item.chapter.thread.id, item.more])
		).toEqual([
			["agent:agent-grace", "thread-flaky", 0],
			["team:team-core", "thread-plan", 0],
			["agent:agent-ada", "thread-notes", 1],
		]);
	});

	test("sorts by recency (empty books last) or title, and searches chapters", () => {
		const shelves = libraryShelves(SNAPSHOT);
		expect(sortBooks(shelves.books, "recent").map((b) => b.title)).toEqual([
			"Grace",
			"Ada",
			"Linus",
		]);
		expect(sortBooks(shelves.collections, "title").map((b) => b.title)).toEqual(
			["Core", "Unassigned", "Website"]
		);
		const ada = findBook(shelves, agentBookId("agent-ada"));
		expect(ada && matchesQuery(ada, "  STYLE ")).toBe(true);
		expect(ada && matchesQuery(ada, "release notes")).toBe(true);
		expect(ada && matchesQuery(ada, "zebra")).toBe(false);
		expect(ada && matchesQuery(ada, "")).toBe(true);
	});

	test("smart views pick waiting and finished books", () => {
		const shelves = libraryShelves(SNAPSHOT);
		expect(viewBooks(shelves, "home").map((b) => b.title)).toEqual([
			"Ada",
			"Grace",
			"Linus",
		]);
		expect(viewBooks(shelves, "all")).toHaveLength(6);
		expect(viewBooks(shelves, "continue").map((b) => b.id)).toEqual([
			"agent:agent-ada",
			"agent:agent-grace",
			"team:team-core",
		]);
		expect(viewBooks(shelves, "finished").map((b) => b.id)).toEqual([
			"project:project-site",
			"team:team-core",
		]);
	});

	test("resume, neighbours and the book a chapter is read in", () => {
		const shelves = libraryShelves(SNAPSHOT);
		const ada = findBook(shelves, agentBookId("agent-ada"));
		// The newest chapter waiting on the user, even a shared team one.
		expect(ada ? resumeChapter(ada)?.thread.id : "").toBe("thread-plan");
		const around = neighbours(ada, "thread-intro");
		expect(around.previous?.thread.id).toBe("thread-style");
		expect(around.current?.number).toBe(2);
		expect(around.next?.thread.id).toBe("thread-notes");
		expect(neighbours(ada, "missing").current).toBeUndefined();
		// The book in hand wins when it holds the chapter.
		expect(
			readingBook(shelves, agentBookId("agent-ada"), "thread-plan")?.id
		).toBe("agent:agent-ada");
		// Otherwise the chapter's primary book.
		expect(readingBook(shelves, null, "thread-plan")?.id).toBe(
			groupBookId({ id: "team-core", kind: "team" })
		);
		expect(readingBook(shelves, null, "thread-loose")?.id).toBe(
			UNASSIGNED_BOOK_ID
		);
	});

	test("covers are stable, printed in their kind's series, in the agent's colour", () => {
		const [ada] = SNAPSHOT.agents;
		expect(coverSpec("agent:agent-ada", "agent", "Ada", ada)).toEqual(
			coverSpec("agent:agent-ada", "agent", "Ada", ada)
		);
		expect(coverSpec("agent:agent-ada", "agent", "Ada", ada).monogram).toBe(
			"A"
		);
		expect(coverSpec("p", "project").layout).toBe("framed");
		expect(coverSpec("t", "team").layout).toBe("stack");
		expect(coverSpec("u", "unassigned").layout).toBe("paper");
		expect(new Set(COVER_LAYOUTS.map((layout) => layout)).size).toBe(4);
	});

	test("author lists and ages read naturally", () => {
		const [ada, grace, linus] = SNAPSHOT.agents;
		if (!(ada && grace && linus)) {
			throw new Error("fixture agents missing");
		}
		expect(authorList([])).toBe("No agent yet");
		expect(authorList([ada])).toBe("Ada");
		expect(authorList([ada, grace])).toBe("Ada and Grace");
		expect(authorList([ada, grace, linus])).toBe("Ada, Grace and Linus");
		expect(authorList([ada, grace, linus, ada, grace])).toBe(
			"Ada, Grace, Linus and 2 more"
		);
		const now = Date.parse("2026-10-12T12:00:00Z");
		const at = (minutes: number) =>
			new Date(now - minutes * MINUTE).toISOString();
		expect(readableAge(at(0), now)).toBe("Just now");
		expect(readableAge(at(18), now)).toBe("18 min ago");
		expect(readableAge(at(60), now)).toBe("1 hr ago");
		expect(readableAge(at(60 * 26), now)).toBe("Yesterday");
		expect(readableAge(at(60 * 24 * 3), now)).toBe("3 days ago");
		expect(readableAge(at(60 * 24 * 15), now)).toBe("2 weeks ago");
		expect(readableAge("not a date", now)).toBe("");
	});
});

describe("library interface", () => {
	test("home shows Continue Reading, the Library grid and Collections", () => {
		const html = renderToStaticMarkup(view());
		expect(html).toContain('data-testid="interface-library"');
		expect(html).toContain("Continue Reading");
		expect(html).toContain("Collections");
		expect(html).toContain('aria-label="Search books"');
		expect(html).toContain("Ada. 3 of 4 chapters finished");
		expect(html).toContain("Linus. No chapters yet");
		expect(html).toContain("Continue Grace, chapter 1: Flaky test");
	});

	test("shows a skeleton while loading and a clear empty library", async () => {
		const loadingHtml = renderToStaticMarkup(
			view({ loading: true, snapshot: EMPTY })
		);
		expect(loadingHtml).toContain('aria-label="Loading library"');
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port, snapshot: EMPTY }));
		expect(mounted.container.textContent).toContain("Your library is empty");
		await click(buttonByLabel(mounted.container, "Start a conversation"));
		expect(calls).toEqual(["start:{}"]);
		await mounted.dispose();
	});

	test("opening a book shows its page, and chapters open through the port", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		await click(buttonStartingWith(mounted.container, "Ada. "));
		const heading = mounted.container.querySelector("h1");
		expect(heading?.textContent).toBe("Ada");
		expect(document.activeElement).toBe(heading);
		expect(mounted.container.textContent).toContain("Contents");
		const rows = mounted.container.querySelectorAll("ol [data-thread-id]");
		expect([...rows].map((row) => row.getAttribute("data-thread-id"))).toEqual([
			"thread-style",
			"thread-intro",
			"thread-notes",
			"thread-plan",
		]);
		await click(
			buttonStartingWith(mounted.container, "Chapter 2: Intro edits")
		);
		expect(calls).toEqual(["open:thread-intro"]);
		await click(buttonByLabel(mounted.container, "Continue"));
		expect(calls.at(-1)).toBe("open:thread-plan");
		await click(buttonByLabel(mounted.container, "Home"));
		expect(mounted.container.textContent).toContain("Continue Reading");
		await mounted.dispose();
	});

	test("the author line names a failure first, then whose turn it is", async () => {
		const mounted = await mount(view());
		const byline = () =>
			mounted.container.querySelector("h1 + p")?.textContent ?? "";
		await click(buttonStartingWith(mounted.container, "Grace. "));
		expect(byline()).toContain("Needs attention in 1 chapter");
		await click(buttonByLabel(mounted.container, "Home"));
		await click(buttonStartingWith(mounted.container, "Ada. "));
		expect(byline()).toContain("Your turn in 3 chapters");
		await click(buttonByLabel(mounted.container, "Home"));
		await click(buttonStartingWith(mounted.container, "Linus. "));
		expect(byline()).toBe("by Linus");
		await mounted.dispose();
	});

	test("Write a chapter starts a thread only with the typed prompt", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		await click(buttonStartingWith(mounted.container, "Ada. "));
		const form = mounted.container.querySelector("form");
		const field = form?.querySelector("textarea");
		if (!(form && field)) {
			throw new Error("composer missing");
		}
		const submit = buttonByLabel(mounted.container, "Write chapter");
		expect(submit?.hasAttribute("disabled")).toBe(true);
		await typeInto(field, "  Summarize the launch  ");
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-ada","prompt":"Summarize the launch"}',
		]);
		await mounted.dispose();
	});

	test("a project collection files new chapters under the project", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		await click(buttonStartingWith(mounted.container, "Website. "));
		expect(mounted.container.querySelector("h1")?.textContent).toBe("Website");
		expect(mounted.container.textContent).toContain("by Ada and Grace");
		const form = mounted.container.querySelector("form");
		const field = form?.querySelector("textarea");
		const picker = form?.querySelector("select");
		if (!(form && field && picker)) {
			throw new Error("collection composer missing");
		}
		await act(async () => {
			picker.value = "agent-grace";
			picker.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await typeInto(field, "Audit the footer links");
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-grace","projectId":"project-site","prompt":"Audit the footer links"}',
		]);
		await mounted.dispose();
	});

	test("Continue Reading resumes the waiting chapter", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		await click(
			buttonByLabel(mounted.container, "Continue Grace, chapter 1: Flaky test")
		);
		expect(calls).toEqual(["open:thread-flaky"]);
		await mounted.dispose();
	});

	test("search narrows the grid and sort reorders it", async () => {
		const mounted = await mount(view());
		const tiles = () =>
			[
				...mounted.container.querySelectorAll(
					"section ul[data-book-grid] > li > button[data-book-id]"
				),
			].map((tile) => tile.getAttribute("data-book-id"));
		expect(tiles().slice(0, 3)).toEqual([
			"agent:agent-grace",
			"agent:agent-ada",
			"agent:agent-linus",
		]);
		await click(buttonByLabel(mounted.container, "Title"));
		expect(tiles().slice(0, 3)).toEqual([
			"agent:agent-ada",
			"agent:agent-grace",
			"agent:agent-linus",
		]);
		const search = mounted.container.querySelector<HTMLInputElement>(
			'input[aria-label="Search books"]'
		);
		if (!search) {
			throw new Error("search missing");
		}
		await typeInto(search, "crash");
		expect(tiles()).toEqual(["agent:agent-grace"]);
		await typeInto(search, "zebra");
		expect(mounted.container.textContent).toContain("No books found");
		await click(buttonByLabel(mounted.container, "Clear search"));
		expect(tiles()).toHaveLength(6);
		await mounted.dispose();
	});

	test("sidebar views list waiting and finished books", async () => {
		const mounted = await mount(view());
		const nav = mounted.container.querySelector('nav[aria-label="Library"]');
		await click(
			[...(nav?.querySelectorAll("button") ?? [])].find((button) =>
				button.textContent?.startsWith("Finished")
			)
		);
		expect(mounted.container.querySelector("h1")?.textContent).toBe("Finished");
		const ids = [
			...mounted.container.querySelectorAll("button[data-book-id]"),
		].map((tile) => tile.getAttribute("data-book-id"));
		expect(ids).toEqual(["team:team-core", "project:project-site"]);
		await mounted.dispose();
	});

	test("the reader wraps the host conversation with chapter controls", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-intro",
				port,
				threadView: <p data-testid="host-chat">Host chat</p>,
			})
		);
		const body = mounted.container.querySelector(
			"[data-testid='library-chapter-body']"
		);
		expect(body?.querySelector("[data-testid='host-chat']")).not.toBeNull();
		expect(mounted.container.querySelector("h1")?.textContent).toBe(
			"Intro edits"
		);
		expect(mounted.container.textContent).toContain("Chapter 2 of 4");
		await click(
			buttonByLabel(mounted.container, "Previous chapter: Style guide")
		);
		await click(
			buttonByLabel(mounted.container, "Next chapter: Release notes")
		);
		expect(calls).toEqual(["open:thread-style", "open:thread-notes"]);
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		});
		expect(calls.at(-1)).toBe("open:thread-notes");
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(calls.at(-1)).toBe("close");
		await click(buttonByLabel(mounted.container, "Back to Ada"));
		expect(calls.at(-1)).toBe("close");
		await mounted.dispose();
	});

	test("a host page over the reader keeps its keys", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-intro",
				port,
				threadView: <p>Host chat</p>,
			})
		);
		const press = async (key: string) => {
			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key }));
			});
		};
		// While the host covers the interface it is inert: keys pass it by.
		mounted.container.setAttribute("inert", "");
		await press("ArrowRight");
		await press("Escape");
		expect(calls).toEqual([]);
		mounted.container.removeAttribute("inert");
		await press("Escape");
		expect(calls).toEqual(["close"]);
		await mounted.dispose();
	});

	test("keys typed inside the conversation never turn the page", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-intro",
				port,
				threadView: <textarea aria-label="Message" />,
			})
		);
		const field = mounted.container.querySelector("textarea");
		await act(async () => {
			field?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
			field?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual([]);
		await mounted.dispose();
	});

	test("leaving the reader returns to the book it was read in", async () => {
		const { port } = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-plan",
				port,
				threadView: <p>Host chat</p>,
			})
		);
		expect(mounted.container.textContent).toContain("Core");
		await click(buttonByLabel(mounted.container, "Back to Core"));
		await mounted.rerender(view({ port }));
		expect(mounted.container.querySelector("h1")?.textContent).toBe("Core");
		await mounted.dispose();
	});
});
