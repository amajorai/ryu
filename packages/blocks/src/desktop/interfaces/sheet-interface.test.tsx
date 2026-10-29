import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SheetInterface } from "./sheet-interface.tsx";
import {
	buildSheetRows,
	clampColumnWidth,
	countSheetStatuses,
	filterSheetRows,
	moveSheetCell,
	nextSheetSort,
	SHEET_COLUMNS,
	SHEET_MAX_COLUMN_WIDTH,
	sheetRelativeTime,
	sheetSnippet,
	sheetSortDirectionLabel,
	sheetTotals,
	sortSheetRows,
	splitMatches,
} from "./sheet-model.ts";

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
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 6,
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			messageCount: 3,
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 11,
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			messageCount: 4,
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-pinned",
			lastMessage: null,
			lastMessageRole: null,
			messageCount: 0,
			pinned: true,
			title: "Ideas",
			updatedAt: ago(60 * 24 * 3),
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
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(target: Element | null | undefined, key: string) {
	if (!(target instanceof HTMLElement)) {
		throw new Error("Expected a key target");
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function typeInto(input: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
}

function bodyTitles(container: HTMLElement): string[] {
	return [...container.querySelectorAll("tbody tr")].map(
		(row) => row.querySelector("[role='rowheader'] span")?.textContent ?? ""
	);
}

function header(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("thead th[scope='col']")].find(
		(cell) => cell.textContent?.trim() === label
	);
}

function focusedCell(): HTMLElement | null {
	const active = document.activeElement;
	return active instanceof HTMLElement && active.dataset.sheetCol !== undefined
		? active
		: null;
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

/** A tiny host: opens threads in local state and shows a stub chat. */
function Host({
	calls,
	snapshot = SNAPSHOT,
}: {
	calls: string[];
	snapshot?: InterfaceSnapshot;
}) {
	const [active, setActive] = useState<string | null>(null);
	const view: ReactNode = active ? (
		<p data-testid="host-chat">Chat for {active}</p>
	) : null;
	return (
		<SheetInterface
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
			threadView={view}
		/>
	);
}

describe("sheet model", () => {
	test("builds rows pinned-first then newest, resolving names and statuses", () => {
		const rows = buildSheetRows(SNAPSHOT);
		expect(rows.map((row) => row.thread.id)).toEqual([
			"thread-pinned",
			"thread-triage",
			"thread-notes",
			"thread-question",
			"thread-flaky",
		]);
		const notes = rows.find((row) => row.thread.id === "thread-notes");
		expect(notes?.team).toBe("Docs Crew");
		expect(notes?.agents.map((agent) => agent.name)).toEqual(["Ada"]);
		expect(rows.find((row) => row.thread.id === "thread-triage")?.project).toBe(
			"Website"
		);
		expect(rows.map((row) => row.status)).toEqual([
			"quiet",
			"working",
			"your-turn",
			"waiting",
			"attention",
		]);
	});

	test("a header click cycles ascending, descending, then off", () => {
		const asc = nextSheetSort(null, "title");
		expect(asc).toEqual({ column: "title", direction: "asc" });
		const desc = nextSheetSort(asc, "title");
		expect(desc).toEqual({ column: "title", direction: "desc" });
		expect(nextSheetSort(desc, "title")).toBe(null);
		expect(nextSheetSort(desc, "messages")).toEqual({
			column: "messages",
			direction: "asc",
		});
	});

	test("sorts by status rank, numbers, and text with blanks last both ways", () => {
		const rows = buildSheetRows(SNAPSHOT);
		const ids = (
			column: Parameters<typeof nextSheetSort>[1],
			dir: "asc" | "desc"
		) =>
			sortSheetRows(rows, { column, direction: dir }).map(
				(row) => row.thread.id
			);
		expect(ids("status", "asc")).toEqual([
			"thread-flaky",
			"thread-notes",
			"thread-triage",
			"thread-question",
			"thread-pinned",
		]);
		expect(ids("messages", "desc")[0]).toBe("thread-triage");
		expect(ids("team", "asc")[0]).toBe("thread-notes");
		expect(ids("team", "desc")[0]).toBe("thread-notes");
		expect(ids("lastMessage", "desc").at(-1)).toBe("thread-pinned");
		expect(ids("pinned", "asc")[0]).toBe("thread-pinned");
		expect(sortSheetRows(rows, null).map((row) => row.thread.id)).toEqual(
			rows.map((row) => row.thread.id)
		);
	});

	test("filters by every query word across fields, and by status", () => {
		const rows = buildSheetRows(SNAPSHOT);
		const ids = (
			query: string,
			status: Parameters<typeof filterSheetRows>[2] = null
		) => filterSheetRows(rows, query, status).map((row) => row.thread.id);
		expect(ids("grace crash")).toEqual(["thread-triage"]);
		expect(ids("docs")).toEqual(["thread-notes"]);
		expect(ids("WEBSITE")).toEqual(["thread-triage"]);
		expect(ids("", "waiting")).toEqual(["thread-question"]);
		expect(ids("nothing-like-this")).toEqual([]);
	});

	test("counts statuses and totals", () => {
		const rows = buildSheetRows(SNAPSHOT);
		expect(countSheetStatuses(rows)).toEqual({
			attention: 1,
			quiet: 1,
			waiting: 1,
			working: 1,
			"your-turn": 1,
		});
		expect(sheetTotals(rows)).toEqual({ messages: 24, pinned: 1 });
	});

	test("marks query matches without losing text", () => {
		const segments = splitMatches("Release notes", "note rel");
		expect(segments.map((segment) => segment.text).join("")).toBe(
			"Release notes"
		);
		expect(
			segments.filter((segment) => segment.match).map((segment) => segment.text)
		).toEqual(["Rel", "note"]);
		expect(splitMatches("Plain", "")).toEqual([
			{ match: false, text: "Plain" },
		]);
	});

	test("trims long cells so a late search hit stays visible", () => {
		const text =
			"Pinned the lockfile and opened a pull request against the release branch";
		expect(sheetSnippet(text, "")).toBe(text);
		expect(sheetSnippet(text, "lockfile")).toBe(text);
		const snippet = sheetSnippet(text, "release");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet).toContain("release branch");
		expect(snippet.indexOf("release")).toBeLessThan(24);
		expect(snippet.slice(1, 2)).not.toBe(" ");
	});

	test("names the sort direction in words", () => {
		expect(sheetSortDirectionLabel({ column: "title", direction: "asc" })).toBe(
			"A → Z"
		);
		expect(
			sheetSortDirectionLabel({ column: "messages", direction: "desc" })
		).toBe("high → low");
		expect(
			sheetSortDirectionLabel({ column: "updated", direction: "desc" })
		).toBe("newest first");
	});

	test("moves the cell cursor like a spreadsheet", () => {
		const rows = 5;
		const last = SHEET_COLUMNS.length - 1;
		expect(moveSheetCell({ col: 0, row: 0 }, { key: "ArrowUp" }, rows)).toEqual(
			{
				col: 0,
				row: -1,
			}
		);
		expect(
			moveSheetCell({ col: 0, row: -1 }, { key: "ArrowUp" }, rows)
		).toEqual({
			col: 0,
			row: -1,
		});
		expect(
			moveSheetCell({ col: 0, row: 4 }, { key: "ArrowDown" }, rows)
		).toEqual({
			col: 0,
			row: 4,
		});
		expect(moveSheetCell({ col: 3, row: 2 }, { key: "Home" }, rows)).toEqual({
			col: 0,
			row: 2,
		});
		expect(moveSheetCell({ col: 3, row: 2 }, { key: "End" }, rows)).toEqual({
			col: last,
			row: 2,
		});
		expect(
			moveSheetCell({ col: 3, row: 2 }, { ctrlKey: true, key: "End" }, rows)
		).toEqual({ col: last, row: 4 });
		expect(
			moveSheetCell({ col: 3, row: 2 }, { key: "Home", metaKey: true }, rows)
		).toEqual({ col: 0, row: 0 });
		expect(
			moveSheetCell({ col: 1, row: 0 }, { key: "PageDown" }, rows)
		).toEqual({
			col: 1,
			row: 4,
		});
		expect(moveSheetCell({ col: 1, row: 3 }, { key: "PageUp" }, rows)).toEqual({
			col: 1,
			row: 0,
		});
		expect(moveSheetCell({ col: 0, row: 0 }, { key: "x" }, rows)).toBe(null);
	});

	test("clamps dragged widths and formats relative times", () => {
		expect(clampColumnWidth("title", 20)).toBe(140);
		expect(clampColumnWidth("agents", 20)).toBe(112);
		expect(clampColumnWidth("title", 5000)).toBe(SHEET_MAX_COLUMN_WIDTH);
		expect(sheetRelativeTime(BASE - 10_000, BASE)).toBe("Just now");
		expect(sheetRelativeTime(BASE - 5 * MINUTE, BASE)).toBe("5m ago");
		expect(sheetRelativeTime(BASE - 3 * 60 * MINUTE, BASE)).toBe("3h ago");
		expect(sheetRelativeTime(BASE - 30 * 60 * MINUTE, BASE)).toBe("Yesterday");
		expect(sheetRelativeTime(BASE - 4 * 24 * 60 * MINUTE, BASE)).toBe("4d ago");
		expect(sheetRelativeTime(0, BASE)).toBe("");
	});
});

describe("SheetInterface", () => {
	test("renders a grid with every column and row, plus loading and empty states", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="interface-sheet"');
		expect(markup).toContain('role="grid"');
		for (const column of SHEET_COLUMNS) {
			expect(markup).toContain(`>${column.label}</span>`);
		}
		expect(markup).toContain("Crash triage");
		expect(markup).toContain(">5 threads<");

		const loading = renderToStaticMarkup(
			<SheetInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, threads: [] }}
				threadView={null}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).not.toContain("No threads yet");

		const empty = renderToStaticMarkup(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(empty).toContain("No threads yet");
		expect(empty).toContain(">Add thread<");
	});

	test("header clicks cycle the sort and report it through aria-sort", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const messages = header(view.container, "Messages");
		expect(messages?.getAttribute("aria-sort")).toBe("none");
		await click(messages);
		expect(messages?.getAttribute("aria-sort")).toBe("ascending");
		expect(bodyTitles(view.container)[0]).toBe("Ideas");
		await click(messages);
		expect(messages?.getAttribute("aria-sort")).toBe("descending");
		expect(bodyTitles(view.container)[0]).toBe("Crash triage");
		expect(view.container.textContent).toContain("Sorted by Messages");
		await click(messages);
		expect(messages?.getAttribute("aria-sort")).toBe("none");
		expect(bodyTitles(view.container)[0]).toBe("Ideas");
		await view.dispose();
	});

	test("arrow keys move a roving cell focus; Enter opens and Escape closes", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const start = view.container.querySelector<HTMLElement>(
			"tbody [tabindex='0']"
		);
		expect(start?.dataset.sheetRow).toBe("0");
		expect(
			view.container.querySelectorAll("[data-sheet-col][tabindex='0']")
		).toHaveLength(1);
		await act(async () => start?.focus());
		await press(start, "ArrowDown");
		await press(focusedCell(), "ArrowRight");
		expect(focusedCell()?.dataset.sheetRow).toBe("1");
		expect(focusedCell()?.dataset.sheetCol).toBe("1");
		expect(focusedCell()?.getAttribute("tabindex")).toBe("0");
		await press(focusedCell(), "End");
		expect(focusedCell()?.dataset.sheetCol).toBe(
			String(SHEET_COLUMNS.length - 1)
		);
		await press(focusedCell(), "Home");
		expect(focusedCell()?.dataset.sheetCol).toBe("0");

		await press(focusedCell(), "Enter");
		expect(calls).toEqual(["open:thread-triage"]);
		const panel = view.container.querySelector(
			"[data-testid='sheet-thread-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Crash triage");
		expect(
			view.container.querySelector("[data-testid='host-chat']")?.textContent
		).toBe("Chat for thread-triage");
		expect(
			view.container
				.querySelector("tr[data-open='true']")
				?.getAttribute("data-thread-id")
		).toBe("thread-triage");

		await click(button(view.container, "Next thread"));
		expect(calls.at(-1)).toBe("open:thread-notes");

		await press(focusedCell() ?? document.body, "Escape");
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("with a thread open, the panel follows the keyboard row and Alt+Arrow steps", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const start = view.container.querySelector<HTMLElement>(
			"tbody [tabindex='0']"
		);
		await act(async () => start?.focus());
		await press(start, "ArrowRight");
		expect(calls).toEqual([]);
		await press(focusedCell(), "Enter");
		await press(focusedCell(), "ArrowDown");
		expect(calls).toEqual(["open:thread-pinned", "open:thread-triage"]);
		await press(focusedCell(), "ArrowRight");
		expect(calls).toHaveLength(2);

		const next = button(view.container, "Next thread");
		await act(async () => {
			next?.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					cancelable: true,
					key: "ArrowDown",
				})
			);
		});
		expect(calls.at(-1)).toBe("open:thread-notes");
		expect(view.container.textContent).toContain("Row 3 of 5");
		await view.dispose();
	});

	test("a filter that hides the cursor row leaves nothing selected", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const start = view.container.querySelector<HTMLElement>(
			"tbody [tabindex='0']"
		);
		await act(async () => start?.focus());
		await press(start, "ArrowDown");
		expect(
			view.container
				.querySelector("tr[aria-selected='true']")
				?.getAttribute("data-thread-id")
		).toBe("thread-triage");
		await click(button(view.container, "Waiting on agent: 1"));
		expect(bodyTitles(view.container)).toEqual(["Intro edits"]);
		expect(view.container.querySelector("header")?.textContent).toContain(
			"1 filter"
		);
		expect(view.container.querySelector("tr[aria-selected='true']")).toBeNull();
		await view.dispose();
	});

	test("Escape inside the host chat stays with the chat", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await press(view.container.querySelector("tbody [tabindex='0']"), "Enter");
		await press(
			view.container.querySelector("[data-testid='host-chat']"),
			"Escape"
		);
		expect(calls).toEqual(["open:thread-pinned"]);
		await view.dispose();
	});

	test("Enter on a header sorts; Alt+Arrow resizes the column", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const title = header(view.container, "Title");
		await press(title, "Enter");
		expect(title?.getAttribute("aria-sort")).toBe("ascending");
		expect(bodyTitles(view.container)[0]).toBe("Crash triage");
		const col = view.container.querySelectorAll("col")[1];
		const before = Number.parseInt(col?.style.width ?? "0", 10);
		await act(async () => {
			title?.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					key: "ArrowRight",
				})
			);
		});
		expect(Number.parseInt(col?.style.width ?? "0", 10)).toBe(before + 16);
		await view.dispose();
	});

	test("search and status tabs narrow the rows; the button starts a thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const input = view.container.querySelector<HTMLInputElement>(
			"input[aria-label='Search threads']"
		);
		if (!input) {
			throw new Error("Expected the search field");
		}
		await typeInto(input, "ada");
		expect(bodyTitles(view.container)).toEqual([
			"Release notes",
			"Intro edits",
		]);
		expect(view.container.textContent).toContain("2 of 5 threads");
		const summary = view.container.querySelector("[data-sheet-summary]");
		expect(summary?.textContent).toContain("2 of 5 threads");
		expect(summary?.textContent).toContain("Sum");
		expect(view.container.querySelector("mark")?.textContent).toBe("Ada");

		await click(button(view.container, "Waiting on agent: 1"));
		expect(bodyTitles(view.container)).toEqual(["Intro edits"]);
		await click(button(view.container, "Waiting on agent: 1"));
		expect(bodyTitles(view.container)).toHaveLength(2);
		await click(button(view.container, "Clear search"));
		expect(bodyTitles(view.container)).toHaveLength(5);

		await typeInto(input, "zzz");
		expect(view.container.textContent).toContain("No threads match “zzz”");
		await click(
			[...view.container.querySelectorAll("button")].find(
				(candidate) => candidate.textContent === "Clear search"
			)
		);
		expect(bodyTitles(view.container)).toHaveLength(5);

		await click(button(view.container, "New thread"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("nothing looks selected until the cursor moves; cells report their column", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		expect(view.container.querySelector("tr[aria-selected='true']")).toBeNull();
		expect(view.container.querySelector("[data-cursor='true']")).toBeNull();
		const start = view.container.querySelector<HTMLElement>(
			"tbody [tabindex='0']"
		);
		await act(async () => start?.focus());
		expect(
			view.container.querySelector("tr[aria-selected='true']")
		).not.toBeNull();
		const headers = [
			...view.container.querySelectorAll("thead th[scope='col']"),
		].map((cell) => cell.getAttribute("aria-colindex"));
		expect(headers).toEqual(
			SHEET_COLUMNS.map((_column, index) => String(index + 1))
		);
		expect(start?.getAttribute("aria-colindex")).toBe("1");
		expect(
			view.container.querySelector("tbody tr")?.getAttribute("aria-rowindex")
		).toBe("2");
		await view.dispose();
	});

	test("keys pressed outside the sheet stay with the host", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await press(view.container.querySelector("tbody [tabindex='0']"), "Enter");
		const outside = document.createElement("button");
		document.body.append(outside);
		await press(outside, "Escape");
		await press(outside, "/");
		expect(calls).toEqual(["open:thread-pinned"]);
		expect(document.activeElement?.getAttribute("aria-label")).not.toBe(
			"Search threads"
		);
		outside.remove();
		await view.dispose();
	});

	test("multi-agent rows name the lead agent plus a count", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{
					...SNAPSHOT,
					threads: [
						thread({
							agentIds: ["agent-ada", "agent-grace"],
							id: "thread-pair",
							title: "Pair",
						}),
					],
				}}
				threadView={null}
			/>
		);
		expect(markup).toContain('<span aria-hidden="true">+1</span>');
		expect(markup).toContain('<span class="sr-only">, Grace</span>');
		expect(markup).toContain(">Add thread<");
		expect(markup).toMatch(
			/role="img" aria-label="Status: [^"]+"|aria-label="Status: [^"]+"[^>]*role="img"/
		);
	});

	test("shows the host's thread view for a new thread with no row", async () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<SheetInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<p>Fresh chat</p>}
			/>
		);
		expect(markup).toContain('aria-label="Thread: New thread"');
		expect(markup).toContain("Fresh chat");
	});
});
