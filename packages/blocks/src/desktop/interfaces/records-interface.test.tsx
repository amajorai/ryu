import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordsInterface } from "./records-interface.tsx";
import {
	RECORDS_DEFAULT_SORT,
	RECORDS_EMPTY_FILTER,
	RECORDS_VIEWS,
	recordsActivity,
	recordsBoard,
	recordsFiltered,
	recordsNextSort,
	recordsRelativeTime,
	recordsRows,
	recordsSorted,
	recordsStartInput,
	recordsStatus,
	recordsTimeUntil,
	recordsViewRows,
} from "./records-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Local mid-day, far from midnight in any time zone. */
const FIXED_NOW = new Date(2026, 9, 14, 12, 0, 0);
const NOW = FIXED_NOW.getTime();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const ahead = (minutes: number) =>
	new Date(NOW + minutes * MINUTE).toISOString();

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
			description: "",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: [
		{
			agentId: "agent-ada",
			id: "event-digest",
			kind: "upcoming",
			label: "Fridays at 5 PM",
			start: ahead(30),
			title: "Weekly digest",
		},
		{
			agentId: "agent-ada",
			end: ago(1),
			id: "event-sync",
			kind: "past",
			label: "Daily at 6 AM",
			outcome: "failure",
			start: ago(2),
			title: "Inbox sync",
		},
		{
			agentId: null,
			id: "event-report",
			kind: "upcoming",
			label: "Monthly",
			start: ahead(60 * 24 * 9),
			title: "Usage report",
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
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(60 * 30),
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
			agentIds: ["agent-ada"],
			id: "thread-review",
			lastMessage: "Review done.",
			runState: "failed",
			teamId: "team-design",
			title: "Design review",
			updatedAt: ago(10),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Day grouping (Today, held, travel days) is local-calendar based, so a fixture
// built from the live clock flips sections when the run straddles midnight.
// Every test runs at one fixed local mid-day instant instead.
beforeEach(() => {
	setSystemTime(FIXED_NOW);
});
afterEach(() => {
	setSystemTime();
});
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

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to press keys on");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function typeInto(field: HTMLInputElement, value: string) {
	let proto: object | null = Object.getPrototypeOf(field);
	let setValue: ((this: HTMLInputElement, next: string) => void) | undefined;
	while (proto && !setValue) {
		setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// React may watch keyup instead when it loaded before the DOM did.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

/** Text a screen reader would read: decorative (aria-hidden) parts removed. */
function spokenText(element: Element): string {
	const copy = element.cloneNode(true);
	if (!(copy instanceof Element)) {
		return "";
	}
	for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
		hidden.remove();
	}
	return copy.textContent?.trim() ?? "";
}

function button(container: HTMLElement, name: string): HTMLElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === name ||
			spokenText(candidate) === name
	);
	if (!match) {
		throw new Error(`No button named ${name}`);
	}
	return match;
}

function tableNames(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll("[data-testid='records-table'] tbody th"),
	].map(spokenText);
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
	overrides: Partial<Parameters<typeof RecordsInterface>[0]> = {}
): ReactElement {
	const { port } = recordingPort();
	return (
		<RecordsInterface
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

describe("records model", () => {
	test("builds agent records with stage, counts, and memberships", () => {
		const rows = recordsRows(SNAPSHOT, "agents");
		const ada = rows.find((row) => row.id === "agent-ada");
		const grace = rows.find((row) => row.id === "agent-grace");
		const linus = rows.find((row) => row.id === "agent-linus");
		// A failed run outranks everything; a live run outranks "your turn".
		expect(ada?.status).toBe("attention");
		expect(ada?.threads.map((item) => item.id)).toEqual([
			"thread-review",
			"thread-notes",
			"thread-question",
		]);
		expect(ada?.needsYou).toBe(2);
		expect(ada?.teams.map((group) => group.name)).toEqual(["Design Review"]);
		expect(grace?.projects.map((group) => group.name)).toEqual(["Website"]);
		expect(linus?.status).toBe("quiet");
		expect(linus?.lastInteraction).toBeNull();
		expect(recordsStatus([], true)).toBe("working");
	});

	test("builds team and project records from their threads", () => {
		const [team] = recordsRows(SNAPSHOT, "teams");
		expect(team?.members.map((agent) => agent.name)).toEqual(["Ada", "Grace"]);
		expect(team?.threads.map((item) => item.id)).toEqual(["thread-review"]);
		expect(team?.description).toBe("Design review");
		const [project] = recordsRows(SNAPSHOT, "projects");
		expect(project?.status).toBe("working");
		expect(recordsStartInput(project ?? (team as never))).toEqual({
			projectId: "project-site",
		});
	});

	test("sorts with natural first directions and flips on a second click", () => {
		const rows = recordsRows(SNAPSHOT, "agents");
		const names = (sort: Parameters<typeof recordsSorted>[1]) =>
			recordsSorted(rows, sort).map((row) => row.name);
		expect(names(RECORDS_DEFAULT_SORT)).toEqual(["Grace", "Ada", "Linus"]);
		const byName = recordsNextSort(RECORDS_DEFAULT_SORT, "name");
		expect(byName).toEqual({ direction: "asc", key: "name" });
		expect(names(byName)).toEqual(["Ada", "Grace", "Linus"]);
		expect(names(recordsNextSort(byName, "name"))).toEqual([
			"Linus",
			"Grace",
			"Ada",
		]);
		expect(names({ direction: "asc", key: "status" })).toEqual([
			"Ada",
			"Grace",
			"Linus",
		]);
	});

	test("filters by stage, needs-you, recency, and search", () => {
		const rows = recordsRows(SNAPSHOT, "agents");
		const ids = (filter: typeof RECORDS_EMPTY_FILTER, query = "") =>
			recordsFiltered(rows, filter, query, NOW).map((row) => row.id);
		expect(ids({ ...RECORDS_EMPTY_FILTER, statuses: ["working"] })).toEqual([
			"agent-grace",
		]);
		expect(ids({ ...RECORDS_EMPTY_FILTER, needsYou: true })).toEqual([
			"agent-ada",
		]);
		expect(ids({ ...RECORDS_EMPTY_FILTER, recentHours: 24 })).toEqual([
			"agent-ada",
			"agent-grace",
		]);
		expect(ids(RECORDS_EMPTY_FILTER, "bugs")).toEqual(["agent-grace"]);
		expect(ids(RECORDS_EMPTY_FILTER, "design review")).toEqual([
			"agent-ada",
			"agent-grace",
		]);
		const working = RECORDS_VIEWS.find((item) => item.id === "view-working");
		if (!working) {
			throw new Error("missing view");
		}
		expect(recordsViewRows(SNAPSHOT, working, NOW)).toHaveLength(1);
		// The recent view is a rolling 24-hour window, and its label says so.
		const recent = RECORDS_VIEWS.find((item) => item.id === "view-recent");
		expect(recent?.filter.recentHours).toBe(24);
		expect(recent?.label).toBe("Active in the last 24 hours");
	});

	test("groups the board by stage and the activity by day", () => {
		const columns = recordsBoard(recordsRows(SNAPSHOT, "agents"));
		expect(columns.map((column) => column.status)).toEqual([
			"attention",
			"working",
			"your-turn",
			"waiting",
			"quiet",
		]);
		expect(columns[0]?.rows.map((row) => row.id)).toEqual(["agent-ada"]);
		const days = recordsActivity(SNAPSHOT.threads, NOW);
		expect(days[0]?.label).toBe("Today");
		expect(days.at(-1)?.items.map((item) => item.id)).toEqual([
			"thread-question",
		]);
	});

	test("attaches scheduled runs to agents and merges them into activity", () => {
		const rows = recordsRows(SNAPSHOT, "agents");
		const ada = rows.find((row) => row.id === "agent-ada");
		expect(ada?.nextRun).toBe(SNAPSHOT.events?.[0]?.start ?? "");
		expect(ada?.upcoming.map((event) => event.id)).toEqual(["event-digest"]);
		expect(ada?.runs.map((event) => event.id)).toEqual(["event-sync"]);
		expect(rows.find((row) => row.id === "agent-linus")?.nextRun).toBeNull();
		const [team] = recordsRows(SNAPSHOT, "teams");
		expect(team?.runs).toEqual([]);

		const [today] = recordsActivity(ada?.threads ?? [], NOW, ada?.runs ?? []);
		expect(today?.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
			"run:event-sync",
			"thread:thread-review",
			"thread:thread-notes",
		]);
		expect(recordsTimeUntil(ahead(30), NOW)).toBe("in 30m");
		expect(recordsTimeUntil(null, NOW)).toBeNull();
	});

	test("formats relative times the way a CRM does", () => {
		expect(recordsRelativeTime(null, NOW)).toBeNull();
		expect(recordsRelativeTime(ago(0.2), NOW)).toBe("Just now");
		expect(recordsRelativeTime(ago(18), NOW)).toBe("18m ago");
		expect(
			recordsRelativeTime(new Date(NOW - 9 * 24 * HOUR).toISOString(), NOW)
		).toMatch(/\d/);
	});
});

describe("RecordsInterface", () => {
	test("renders the agents table, loading, and empty states", () => {
		const markup = renderToStaticMarkup(view());
		expect(markup).toContain('data-testid="interface-records"');
		expect(markup).toContain('data-testid="records-table"');
		expect(markup).toContain("Description");
		expect(markup).toContain('aria-sort="descending"');

		const empty = { ...SNAPSHOT, agents: [], groups: [], threads: [] };
		const loading = renderToStaticMarkup(
			view({ loading: true, snapshot: empty })
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("records-empty");

		const none = renderToStaticMarkup(view({ snapshot: empty }));
		expect(none).toContain('data-testid="records-empty"');
		expect(none).toContain("No agents yet");
	});

	test("sorts from the header and switches objects and views", async () => {
		const mounted = await mount(view());
		const { container } = mounted;
		expect(tableNames(container)).toEqual(["Grace", "Ada", "Linus"]);

		await click(button(container, "Name"));
		expect(tableNames(container)).toEqual(["Ada", "Grace", "Linus"]);
		expect(
			container.querySelector("th[aria-sort='ascending']")?.textContent
		).toContain("Name");

		await click(button(container, "Teams1 records"));
		expect(tableNames(container)).toEqual(["Design Review"]);
		expect(container.textContent).toContain("Members");

		await click(button(container, "Working now1 records"));
		expect(tableNames(container)).toEqual(["Grace"]);
		expect(container.textContent).toContain("Working now");
		await mounted.dispose();
	});

	test("searches, shows a no-match state, and clears it", async () => {
		const mounted = await mount(view());
		const { container } = mounted;
		const search = container.querySelector("input[type='search']");
		if (!(search instanceof HTMLInputElement)) {
			throw new Error("search");
		}
		await typeInto(search, "zzz");
		expect(
			container.querySelector("[data-testid='records-no-match']")
		).not.toBeNull();
		await click(button(container, "Clear filters"));
		expect(tableNames(container)).toHaveLength(3);
		await mounted.dispose();
	});

	test("moves through rows with the keyboard and opens a record page", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		const { container } = mounted;
		const first = button(container, "Grace");
		expect(first.tabIndex).toBe(0);
		await act(async () => first.focus());
		await press(first, "ArrowDown");
		expect(document.activeElement?.textContent).toBe("Ada");

		await click(document.activeElement);
		const page = container.querySelector("[data-testid='records-page']");
		expect(page?.querySelector("h2")?.textContent).toBe("Ada");
		expect(page?.textContent).toContain("2 of 3");
		expect(page?.textContent).toContain("Today");
		expect(page?.textContent).toContain("You: Can you shorten the intro?");

		await click(button(container, "Message"));
		expect(calls).toContain('start:{"agentId":"agent-ada"}');

		await click(button(container, "Next record"));
		expect(
			container.querySelector("[data-testid='records-page'] h2")?.textContent
		).toBe("Linus");
		expect(container.textContent).toContain("No activity yet");

		await press(
			container.querySelector("[data-testid='records-page'] h2"),
			"Escape"
		);
		expect(container.querySelector("[data-testid='records-page']")).toBeNull();
		expect(document.activeElement?.textContent).toBe("Linus");
		await mounted.dispose();
	});

	test("opens threads in the host's view and follows related records", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(view({ port }));
		const { container } = mounted;
		await click(button(container, "Ada"));
		const entry = [
			...container.querySelectorAll("[data-testid='records-page'] ol button"),
		].find((candidate) => candidate.textContent?.includes("Release notes"));
		await click(entry);
		expect(calls).toContain("open:thread-notes");

		await mounted.rerender(
			view({
				activeThreadId: "thread-notes",
				port,
				threadView: <div data-testid="host-chat">Host chat</div>,
			})
		);
		const panel = container.querySelector(
			"[data-testid='records-thread-panel']"
		);
		expect(panel?.querySelector("[data-testid='host-chat']")).not.toBeNull();
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Release notes");
		await click(button(container, "Close thread"));
		expect(calls).toContain("close");

		await mounted.rerender(view({ port }));
		await click(button(container, "Design Review"));
		expect(
			container.querySelector("[data-testid='records-page'] h2")?.textContent
		).toBe("Design Review");
		expect(container.textContent).toContain("Teams");
		await click(button(container, "Message"));
		expect(calls).toContain('start:{"teamId":"team-design"}');
		await mounted.dispose();
	});

	test("shows next runs and footer sums in the table", async () => {
		const mounted = await mount(view());
		const { container } = mounted;
		const ada = container.querySelector("tr[data-record-id='agent-ada']");
		// The clock may tick a minute between fixture and render.
		expect(ada?.textContent).toMatch(/in (29|30)m/);
		const footer = container.querySelector(
			"[data-testid='records-table'] tfoot"
		);
		expect(spokenText(footer ?? container)).toContain("3 agents");
		expect(footer?.textContent).toContain("Sum4");
		await mounted.dispose();
	});

	test("lists upcoming and past runs on the record's timeline", async () => {
		const mounted = await mount(view());
		const { container } = mounted;
		await click(button(container, "Ada"));
		const page = container.querySelector("[data-testid='records-page']");
		const upcoming = page?.querySelector("section[aria-label='Upcoming']");
		expect(upcoming?.textContent).toContain("Weekly digest");
		expect(upcoming?.textContent).toContain("Fridays at 5 PM");
		const today = page?.querySelector("section[aria-label='Today']");
		expect(today?.textContent).toContain("Inbox sync");
		expect(today?.textContent).toContain("Failed");
		// Runs are read-only: only threads are buttons on the timeline.
		const entries = [...(today?.querySelectorAll("li") ?? [])];
		expect(
			entries.map((entry) => entry.querySelector("button") !== null)
		).toEqual([false, true, true]);
		expect(page?.querySelector("aside")?.textContent).toContain(
			"Weekly digest"
		);
		await mounted.dispose();
	});

	test("lands a deep-linked thread on its agent's page, details inline", async () => {
		const { calls, port } = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-triage",
				port,
				threadView: <div data-testid="host-chat">Host chat</div>,
			})
		);
		const { container } = mounted;
		const page = container.querySelector("[data-testid='records-page']");
		expect(page?.querySelector("h2")?.textContent).toBe("Grace");
		expect(
			page?.querySelector("[data-testid='records-thread-panel']")
		).not.toBeNull();
		expect(page?.querySelector("#records-details-inline")).not.toBeNull();
		const active = page?.querySelector("ol button[aria-current='true']");
		expect(active?.textContent).toContain("Crash triage");

		// Going back keeps the chat docked beside the table, without re-opening.
		await click(button(container, "Agents"));
		expect(container.querySelector("[data-testid='records-page']")).toBeNull();
		expect(
			container.querySelector("[data-testid='records-thread-panel']")
		).not.toBeNull();
		await press(
			container.querySelector("[data-testid='records-thread-panel'] header"),
			"Escape"
		);
		expect(calls).toEqual(["close"]);
		await mounted.dispose();
	});

	test("shows the board by status", async () => {
		const mounted = await mount(view());
		const { container } = mounted;
		await click(button(container, "Board by status"));
		const board = container.querySelector("[data-testid='records-board']");
		expect(board).not.toBeNull();
		const columns = [...(board?.querySelectorAll("section") ?? [])].map(
			(section) => section.getAttribute("aria-label")
		);
		expect(columns).toEqual([
			"Needs attention, 1",
			"Working, 1",
			"Your turn, 0",
			"Waiting on agent, 0",
			"Not started, 1",
		]);
		await mounted.dispose();
	});
});
