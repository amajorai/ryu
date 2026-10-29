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
import { NotebookHome } from "./notebook-home.tsx";
import { NotebookInterface } from "./notebook-interface.tsx";
import {
	ancestorIdsOf,
	buildNotebookTree,
	initialNotebookExpanded,
	notebookEditedLabel,
	notebookGreeting,
	notebookNeedsYou,
	notebookPlacement,
	notebookRunTime,
	notebookStartInput,
	notebookTreeMove,
	recentNotebookPages,
	upcomingNotebookEvents,
	visibleNotebookRows,
} from "./notebook-model.ts";
import { sidebarShowsStatus } from "./notebook-parts.tsx";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: [
		{
			agentId: "agent-ada",
			id: "event-past",
			kind: "past",
			label: "Daily",
			outcome: "success",
			start: ago(120),
			title: "Digest",
		},
		{
			agentId: "agent-ada",
			id: "event-later",
			kind: "upcoming",
			label: "Weekly",
			start: new Date(BASE + 30 * HOUR).toISOString(),
			title: "Weekly recap",
		},
		{
			agentId: null,
			id: "event-soon",
			kind: "upcoming",
			label: "Hourly",
			start: new Date(BASE + 20 * MINUTE).toISOString(),
			title: "Inbox sweep",
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
			pinned: true,
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			projectId: "project-site",
			running: true,
			teamId: "team-docs",
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
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

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a focusable element");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

function treeItem(container: HTMLElement, label: string) {
	return [...container.querySelectorAll('[role="treeitem"]')].find(
		(candidate) => candidate.getAttribute("aria-label")?.startsWith(label)
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

describe("notebook model", () => {
	test("files each thread under its project, team, lead agent, or Unfiled", () => {
		const tree = buildNotebookTree(SNAPSHOT);
		expect(tree.map((section) => section.label)).toEqual([
			"Favorites",
			"Projects",
			"Teams",
			"Agents",
			"Unfiled",
		]);
		const titles = (key: string) =>
			tree
				.find((section) => section.key === key)
				?.children.flatMap((child) =>
					child.kind === "group"
						? [
								`${child.label}:${child.pages.map((page) => page.title).join("|")}`,
							]
						: [child.title]
				);
		expect(titles("favorites")).toEqual(["Release notes"]);
		// A thread with a project and a team files under its project only.
		expect(titles("projects")).toEqual(["Site:Crash triage"]);
		expect(titles("teams")).toEqual(["Docs Crew:Release notes"]);
		// Every agent gets a row, even with no pages, so "+" can start one.
		expect(titles("agents")).toEqual([
			"Ada:Intro edits",
			"Grace:Flaky test",
			"Linus:",
		]);
		expect(titles("unfiled")).toEqual(["Loose ends"]);
	});

	test("node ids stay unique when a pinned page also shows in Favorites", () => {
		const rows = visibleNotebookRows(
			buildNotebookTree(SNAPSHOT),
			new Set(["section:favorites", "section:teams", "team:team-docs"])
		);
		const ids = rows.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("section:favorites/thread-notes");
		expect(ids).toContain("team:team-docs/thread-notes");
	});

	test("search keeps matching pages, whole matching parents, and drops empty sections", () => {
		const byTitle = buildNotebookTree(SNAPSHOT, "  TRIAGE ");
		expect(byTitle.map((section) => section.key)).toEqual(["projects"]);
		const byParent = buildNotebookTree(SNAPSHOT, "ada");
		const agents = byParent.find((section) => section.key === "agents");
		expect(agents?.children.map((child) => child.id)).toEqual([
			"agent:agent-ada",
		]);
		expect(buildNotebookTree(SNAPSHOT, "nothing like this")).toEqual([]);
	});

	test("agents stay alphabetical, with or without pages", () => {
		const tree = buildNotebookTree({
			...SNAPSHOT,
			agents: [
				...SNAPSHOT.agents,
				{
					avatarUrl: null,
					description: "New hire",
					id: "agent-abe",
					name: "Abe",
					status: "idle",
				},
			],
		});
		const agents = tree.find((section) => section.key === "agents");
		expect(agents?.children.map((child) => child.id)).toEqual([
			"agent:agent-abe",
			"agent:agent-ada",
			"agent:agent-grace",
			"agent:agent-linus",
		]);
	});

	test("placement prefers project, then team, then lead agent", () => {
		expect(
			notebookPlacement(SNAPSHOT, {
				agentIds: ["agent-ada"],
				projectId: "project-site",
				teamId: "team-docs",
			})
		).toEqual({
			group: { id: "project-site", kind: "project", label: "Site" },
			section: "projects",
		});
		expect(
			notebookPlacement(SNAPSHOT, {
				agentIds: ["agent-ada"],
				projectId: "project-missing",
				teamId: null,
			}).section
		).toBe("agents");
		expect(
			notebookPlacement(SNAPSHOT, {
				agentIds: [],
				projectId: null,
				teamId: null,
			})
		).toEqual({ group: null, section: "unfiled" });
	});

	test("opens sections, project/team parents, and the active page's parent", () => {
		const tree = buildNotebookTree(SNAPSHOT);
		const expanded = initialNotebookExpanded(tree, "thread-flaky");
		expect(expanded.has("section:agents")).toBe(true);
		expect(expanded.has("project:project-site")).toBe(true);
		expect(expanded.has("team:team-docs")).toBe(true);
		expect(expanded.has("agent:agent-grace")).toBe(true);
		expect(expanded.has("agent:agent-ada")).toBe(false);
		expect(ancestorIdsOf(tree, "thread-loose")).toEqual(["section:unfiled"]);
		expect(ancestorIdsOf(tree, "thread-notes")).toEqual([
			"section:teams",
			"team:team-docs",
		]);
		expect(ancestorIdsOf(tree, null)).toEqual([]);
	});

	test("arrow keys follow the WAI-ARIA tree pattern", () => {
		const tree = buildNotebookTree(SNAPSHOT);
		const expanded = new Set(["section:agents", "agent:agent-ada"]);
		const rows = visibleNotebookRows(tree, expanded);
		expect(rows.map((row) => row.id)).toEqual([
			"section:favorites",
			"section:projects",
			"section:teams",
			"section:agents",
			"agent:agent-ada",
			"agent:agent-ada/thread-question",
			"agent:agent-grace",
			"agent:agent-linus",
			"section:unfiled",
		]);
		expect(notebookTreeMove(rows, "section:teams", "ArrowDown")).toEqual({
			id: "section:agents",
			type: "focus",
		});
		expect(notebookTreeMove(rows, "section:teams", "ArrowRight")).toEqual({
			id: "section:teams",
			type: "expand",
		});
		expect(notebookTreeMove(rows, "agent:agent-ada", "ArrowRight")).toEqual({
			id: "agent:agent-ada/thread-question",
			type: "focus",
		});
		expect(notebookTreeMove(rows, "agent:agent-ada", "ArrowLeft")).toEqual({
			id: "agent:agent-ada",
			type: "collapse",
		});
		expect(
			notebookTreeMove(rows, "agent:agent-ada/thread-question", "ArrowLeft")
		).toEqual({ id: "agent:agent-ada", type: "focus" });
		expect(
			notebookTreeMove(rows, "agent:agent-ada/thread-question", "Enter")
		).toEqual({ threadId: "thread-question", type: "open" });
		expect(notebookTreeMove(rows, "agent:agent-grace", "Enter")).toEqual({
			id: "agent:agent-grace",
			type: "toggle",
		});
		expect(notebookTreeMove(rows, "agent:agent-grace", "End")).toEqual({
			id: "section:unfiled",
			type: "focus",
		});
		expect(notebookTreeMove(rows, "section:unfiled", "Home")).toEqual({
			id: "section:favorites",
			type: "focus",
		});
		expect(notebookTreeMove(rows, "section:favorites", "ArrowUp")).toBe(null);
		expect(notebookTreeMove(rows, "gone", "ArrowDown")).toEqual({
			id: "section:favorites",
			type: "focus",
		});
	});

	test("a parent's + starts a thread filed there", () => {
		const tree = buildNotebookTree(SNAPSHOT);
		const groups = tree.flatMap((section) =>
			section.children.filter((child) => child.kind === "group")
		);
		expect(
			groups.map((group) =>
				group.kind === "group" ? notebookStartInput(group) : null
			)
		).toEqual([
			{ projectId: "project-site" },
			{ teamId: "team-docs" },
			{ agentId: "agent-ada" },
			{ agentId: "agent-grace" },
			{ agentId: "agent-linus" },
		]);
	});

	test("Home lists: recent pages, what needs you, and upcoming runs", () => {
		expect(recentNotebookPages(SNAPSHOT, 2).map((item) => item.id)).toEqual([
			"thread-triage",
			"thread-notes",
		]);
		expect(notebookNeedsYou(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-flaky",
			"thread-notes",
		]);
		expect(upcomingNotebookEvents(SNAPSHOT, BASE).map((e) => e.id)).toEqual([
			"event-soon",
			"event-later",
		]);
		expect(
			upcomingNotebookEvents({ ...SNAPSHOT, events: undefined }, BASE)
		).toEqual([]);
	});

	test("greets by time of day and labels edits like Notion", () => {
		expect(notebookGreeting(new Date(2026, 9, 12, 8))).toBe("Good morning");
		expect(notebookGreeting(new Date(2026, 9, 12, 14))).toBe("Good afternoon");
		expect(notebookGreeting(new Date(2026, 9, 12, 21))).toBe("Good evening");
		expect(notebookGreeting(new Date(2026, 9, 12, 2))).toBe("Good evening");
		expect(notebookEditedLabel(ago(0), BASE)).toBe("Just now");
		expect(notebookEditedLabel(ago(1), BASE)).toBe("1 minute ago");
		expect(notebookEditedLabel(ago(42), BASE)).toBe("42 minutes ago");
		expect(notebookEditedLabel(ago(180), BASE)).toBe("3 hours ago");
		expect(notebookEditedLabel(ago(60 * 30), BASE)).toBe("Yesterday");
		expect(notebookEditedLabel(ago(60 * 24 * 3), BASE)).toBe("3 days ago");
		expect(notebookEditedLabel("not a date", BASE)).toBe("");
		const soon = notebookRunTime(
			new Date(BASE + 20 * MINUTE).toISOString(),
			BASE
		);
		expect(soon.day).toBe("In 20 min");
		expect(soon.time).not.toBe(null);
		expect(
			notebookRunTime(new Date(BASE + 26 * HOUR).toISOString(), BASE).time
		).not.toBe(null);
	});
});

describe("NotebookInterface", () => {
	test("renders a loading skeleton and an empty notebook", () => {
		const { port } = recordingPort();
		const loadingMarkup = renderToStaticMarkup(
			<NotebookInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-notebook"');
		expect(loadingMarkup).toContain("animate-skeleton");
		expect(loadingMarkup).not.toContain("Recently edited");

		const emptyMarkup = renderToStaticMarkup(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{
					...SNAPSHOT,
					agents: [],
					events: [],
					groups: [],
					threads: [],
				}}
				threadView={null}
			/>
		);
		expect(emptyMarkup).toContain("Your notebook is empty");
		expect(emptyMarkup).toContain("No pages yet");
		expect(emptyMarkup).not.toContain('role="tree"');
	});

	test("Home opens pages from the gallery and starts a new page", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const text = view.container.textContent ?? "";
		expect(text).toContain("Recently edited");
		expect(text).toContain("Needs you");
		expect(text).toContain("Upcoming runs");
		expect(view.container.querySelector('[role="tree"]')).not.toBe(null);
		const card = [...view.container.querySelectorAll("button")].find(
			(candidate) =>
				candidate
					.getAttribute("aria-label")
					?.startsWith("Crash triage, Working")
		);
		await click(card);
		const newPageCard = [...view.container.querySelectorAll("li button")].find(
			(candidate) => candidate.textContent?.trim() === "New page"
		);
		await click(newPageCard);
		expect(calls).toEqual(["open:thread-triage", "start:{}"]);
		await view.dispose();
	});

	test("the tree opens pages and + starts a page in that parent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const page = treeItem(view.container, "Crash triage");
		await click(page?.querySelector("div"));
		await click(button(view.container, "New page in Site"));
		await click(button(view.container, "New page in Docs Crew"));
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"projectId":"project-site"}',
			'start:{"teamId":"team-docs"}',
		]);
		// Agents start folded; clicking a parent row unfolds it.
		const linus = treeItem(view.container, "Linus");
		expect(linus?.getAttribute("aria-expanded")).toBe("false");
		await click(linus?.querySelector("div"));
		expect(linus?.getAttribute("aria-expanded")).toBe("true");
		expect(linus?.textContent).toContain("No pages inside");
		await view.dispose();
	});

	test("keyboard moves through the tree, folds parents, and opens pages", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const tree = view.container.querySelector('[role="tree"]');
		const tabStops = view.container.querySelectorAll(
			'[role="treeitem"][tabindex="0"]'
		);
		expect(tabStops.length).toBe(1);
		const projects = treeItem(view.container, "Projects");
		await act(async () => (projects as HTMLElement).focus());
		await press(projects, "ArrowDown");
		const site = treeItem(view.container, "Site");
		expect(document.activeElement).toBe(site ?? null);
		await press(site, "ArrowLeft");
		expect(site?.getAttribute("aria-expanded")).toBe("false");
		await press(site, "ArrowRight");
		expect(site?.getAttribute("aria-expanded")).toBe("true");
		await press(site, "ArrowRight");
		const triage = treeItem(view.container, "Crash triage");
		expect(document.activeElement).toBe(triage ?? null);
		await press(triage, "Enter");
		await press(tree?.querySelector('[tabindex="0"]'), "ArrowLeft");
		expect(document.activeElement).toBe(site ?? null);
		await press(site, "n");
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"projectId":"project-site"}',
		]);
		await view.dispose();
	});

	test("search filters the tree and Escape clears it", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const input = view.container.querySelector('input[type="search"]');
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected the search field");
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			input.focus();
			setValue?.call(input, "flaky");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		const labels = [
			...view.container.querySelectorAll('[role="treeitem"]'),
		].map((item) => item.getAttribute("aria-label"));
		expect(labels).toEqual([
			"Agents",
			"Grace, agent, working, 1 page",
			"Flaky test, Needs attention",
		]);
		await press(input, "Escape");
		expect(input.value).toBe("");
		expect(
			view.container.querySelectorAll('[role="treeitem"]').length
		).toBeGreaterThan(3);
		await view.dispose();
	});

	test("Ctrl+Shift+F focuses Search from anywhere in the notebook", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const input = view.container.querySelector('input[type="search"]');
		expect(input?.getAttribute("aria-keyshortcuts")).toContain(
			"Control+Shift+F"
		);
		expect(input?.getAttribute("aria-keyshortcuts")).not.toContain("Control+K");
		// Mod+K belongs to the desktop command palette: the notebook ignores it.
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { ctrlKey: true, key: "k" })
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		expect(
			document.activeElement ===
				view.container.querySelector('input[type="search"]')
		).toBe(false);
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", {
					ctrlKey: true,
					key: "F",
					shiftKey: true,
				})
			);
		});
		// The field focuses two frames later, once the sidebar has settled.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		const field = view.container.querySelector('input[type="search"]');
		expect(field !== null && document.activeElement === field).toBe(true);
		await view.dispose();
	});

	test("the sidebar marks only failures and live runs", () => {
		expect(sidebarShowsStatus("attention")).toBe(true);
		expect(sidebarShowsStatus("working")).toBe(true);
		expect(sidebarShowsStatus("your-turn")).toBe(false);
		expect(sidebarShowsStatus("waiting")).toBe(false);
		expect(sidebarShowsStatus("quiet")).toBe(false);
	});

	test("an open thread is a page: crumbs, title, properties, then the host view", async () => {
		const { calls, port } = recordingPort();
		const hostView = <div data-testid="host-view">Real chat</div>;
		const view = await mount(
			<NotebookInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={hostView}
			/>
		);
		const body = view.container.querySelector(
			'[data-testid="notebook-page-body"]'
		);
		expect(body?.querySelector('[data-testid="host-view"]')).not.toBe(null);
		expect(view.container.querySelector("h1")?.textContent).toBe(
			"Crash triage"
		);
		const crumbs = [
			...view.container.querySelectorAll('nav[aria-label="Breadcrumb"] li'),
		]
			.map((item) => item.textContent?.trim())
			.filter((value) => value && value !== "/");
		// Crumbs start at the top-level page, not the sidebar section.
		expect(crumbs).toEqual(["Site", "Crash triage"]);
		const properties = view.container.querySelector("dl")?.textContent ?? "";
		expect(properties).toContain("Working");
		expect(properties).toContain("Grace");
		expect(properties).toContain("Docs Crew");
		expect(properties).toContain("Site");
		const active = treeItem(view.container, "Crash triage");
		expect(active?.getAttribute("aria-selected")).toBe("true");
		expect(active?.getAttribute("tabindex")).toBe("0");

		await click(button(view.container, "Hide properties"));
		expect(view.container.querySelector("dl")).toBe(null);
		await click(button(view.container, "Close page"));
		const home = [...view.container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.startsWith("Home")
		);
		await click(home);
		expect(calls).toEqual(["close", "close"]);
		await view.dispose();
	});

	test("opening a page from outside unfolds its parent once", async () => {
		const { port } = recordingPort();
		const shell = (activeThreadId: string | null) => (
			<NotebookInterface
				activeThreadId={activeThreadId}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={activeThreadId ? <div>Chat</div> : null}
			/>
		);
		const view = await mount(shell(null));
		const grace = () => treeItem(view.container, "Grace");
		expect(grace()?.getAttribute("aria-expanded")).toBe("false");
		await view.rerender(shell("thread-flaky"));
		expect(grace()?.getAttribute("aria-expanded")).toBe("true");
		// Folding it again sticks while the same page stays open.
		await click(grace()?.querySelector("div"));
		await view.rerender(shell("thread-flaky"));
		expect(grace()?.getAttribute("aria-expanded")).toBe("false");
		await view.dispose();
	});

	test("a new page from a parent's + shows as Untitled, filed there", async () => {
		const { port } = recordingPort();
		const shell = (threadView: ReactElement | null) => (
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={threadView}
			/>
		);
		const view = await mount(shell(null));
		await click(button(view.container, "New page in Docs Crew"));
		await view.rerender(shell(<div data-testid="host-view">New chat</div>));
		expect(view.container.querySelector("h1")?.textContent).toBe("Untitled");
		const crumbs = view.container.querySelector(
			'nav[aria-label="Breadcrumb"]'
		)?.textContent;
		expect(crumbs).toBe("Docs Crew/Untitled");
		const properties = view.container.querySelector("dl")?.textContent ?? "";
		expect(properties).toContain("Not started");
		expect(properties).toContain("Ada");
		expect(properties).toContain("Linus");
		await view.dispose();
	});

	test("Home names its badge, and Full width widens Home too", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(button(view.container, "Home, 2 need you")).toBeDefined();
		const column = () =>
			view.container.querySelector("main h1")?.closest("header")?.parentElement
				?.className ?? "";
		expect(column()).toContain("max-w-[58rem]");
		// Full width lives in the "•••" page menu, as in Notion, not as a loose
		// top-bar icon.
		const trigger = button(view.container, "Page options");
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		expect(button(view.container, "Full width")).toBeUndefined();
		await view.dispose();
		const wide = renderToStaticMarkup(
			<NotebookHome
				fullWidth
				loading={false}
				now={Date.now()}
				onNewPage={() => undefined}
				onOpen={() => undefined}
				snapshot={SNAPSHOT}
			/>
		);
		expect(wide).toContain("max-w-none");
		expect(wide).not.toContain("max-w-[58rem]");
	});

	test("opening another page drops the placement of a page started from +", async () => {
		const { port } = recordingPort();
		const shell = (
			activeThreadId: string | null,
			threadView: ReactElement | null
		) => (
			<NotebookInterface
				activeThreadId={activeThreadId}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={threadView}
			/>
		);
		const view = await mount(shell(null, null));
		await click(button(view.container, "New page in Docs Crew"));
		await click(treeItem(view.container, "Crash triage")?.querySelector("div"));
		// The host opens a page the snapshot does not list yet.
		await view.rerender(shell("thread-fresh", <div>Fresh chat</div>));
		const crumbs = view.container.querySelector(
			'nav[aria-label="Breadcrumb"]'
		)?.textContent;
		// An unfiled page is top level: its crumb is the page alone.
		expect(crumbs).toBe("Untitled");
		await view.dispose();
	});
	test("a page shows its last run, and a crumb flashes its sidebar row", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<NotebookInterface
				activeThreadId="thread-flaky"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Chat</div>}
			/>
		);
		const properties = view.container.querySelector("dl")?.textContent ?? "";
		expect(properties).toContain("Last run");
		expect(properties).toContain("Failed");
		expect(properties).toMatch(/Failed·\d+[a-z]+ ago/);
		await click(button(view.container, "Hide properties"));
		expect(button(view.container, "7 properties")).toBeUndefined();
		expect(view.container.textContent).toContain("7 properties");

		const crumb = [
			...view.container.querySelectorAll('nav[aria-label="Breadcrumb"] button'),
		].find((candidate) => candidate.textContent?.trim() === "Grace");
		await click(crumb);
		const row = treeItem(view.container, "Grace")?.querySelector("div");
		expect(row?.getAttribute("data-revealed")).toBe("on");
		await view.dispose();
	});

	test("neutral status pills keep foreground text for contrast", async () => {
		const view = await mount(
			<NotebookInterface
				activeThreadId="thread-quiet"
				loading={false}
				params={{}}
				port={recordingPort().port}
				snapshot={{
					...SNAPSHOT,
					threads: [
						...SNAPSHOT.threads,
						thread({
							id: "thread-quiet",
							lastMessageRole: "user",
							title: "Quiet",
						}),
					],
				}}
				threadView={<div>Chat</div>}
			/>
		);
		const pill = view.container.querySelector("dl dd > span");
		expect(pill?.textContent).toContain("Waiting");
		expect(pill?.className).toContain("text-foreground/80");
		expect(pill?.className).not.toContain("text-muted-foreground");
		await view.dispose();
	});

	test("Needs you lists five pages, then offers the rest", async () => {
		const extra = ["a", "b", "c", "d", "e"].map((key, index) =>
			thread({
				id: `thread-failed-${key}`,
				runState: "failed",
				title: `Failed ${key}`,
				updatedAt: ago(200 + index),
			})
		);
		const view = await mount(
			<NotebookInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={recordingPort().port}
				snapshot={{ ...SNAPSHOT, threads: [...SNAPSHOT.threads, ...extra] }}
				threadView={null}
			/>
		);
		const needsYou = () =>
			view.container.querySelectorAll(
				'ul[aria-labelledby="notebook-needs-you"] li'
			).length;
		expect(needsYou()).toBe(5);
		const more = button(view.container, "Show all 7");
		expect(more?.getAttribute("aria-expanded")).toBe("false");
		await click(more);
		expect(needsYou()).toBe(7);
		expect(button(view.container, "Show fewer")).toBeDefined();
		await view.dispose();
	});
});
