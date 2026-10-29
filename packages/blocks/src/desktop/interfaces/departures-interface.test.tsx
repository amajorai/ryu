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
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DeparturesInterface } from "./departures-interface.tsx";
import {
	airlineCodes,
	boardDate,
	boardForThread,
	boardTime,
	buildBoards,
	flightAccessibleName,
	flightDuration,
	flightNumber,
	flightProgress,
	flightTimeline,
	nextRowIndex,
	typicalFlightMs,
} from "./departures-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * Local noon on a fixed day, so day boundaries never fall inside the fixture
 * (a run just after midnight would otherwise move threads to yesterday).
 */
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

function fixture(now: number): InterfaceSnapshot {
	const ago = (minutes: number) =>
		new Date(now - minutes * MINUTE).toISOString();
	const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
	const thread = (
		input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
	): InterfaceThread => ({
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
	});
	const events: InterfaceEvent[] = [
		{
			agentId: "agent-ada",
			end: at(-26 + 0.2),
			id: "event-past",
			kind: "past",
			label: "Daily at 6 AM",
			outcome: "success",
			start: at(-26),
			title: "Backup check",
		},
		{
			agentId: "agent-ada",
			id: "event-next",
			kind: "upcoming",
			label: "Daily at 6 AM",
			start: at(2),
			title: "Backup check",
		},
	];
	return {
		agents: [
			{
				avatarUrl: null,
				description: "Writes the release notes",
				id: "agent-ada",
				name: "Ada",
				status: "working",
			},
			{
				avatarUrl: null,
				description: "Triages bugs",
				id: "agent-adam",
				name: "Adam",
				status: "idle",
			},
		],
		events,
		groups: [
			{
				id: "project-site",
				kind: "project",
				memberAgentIds: ["agent-ada"],
				name: "Website",
			},
		],
		threads: [
			thread({
				agentIds: ["agent-ada"],
				id: "thread-live",
				projectId: "project-site",
				running: true,
				title: "Rebuild the hero",
				updatedAt: ago(5),
			}),
			thread({
				agentIds: ["agent-adam"],
				id: "thread-asked",
				lastMessageRole: "user",
				title: "Compare papers",
				updatedAt: ago(90),
			}),
			thread({
				agentIds: ["agent-ada"],
				id: "thread-fresh",
				title: "Palette options",
				updatedAt: ago(10),
			}),
			thread({
				agentIds: ["agent-adam"],
				id: "thread-gate",
				title: "Release notes",
				updatedAt: ago(120),
			}),
			thread({
				agentIds: ["agent-adam"],
				id: "thread-failed",
				runState: "failed",
				title: "Audit lockfile",
				updatedAt: ago(30),
			}),
			thread({
				agentIds: ["agent-ada"],
				id: "thread-old",
				title: "Style guide",
				updatedAt: ago(60 * 30),
			}),
		],
		version: 1,
	};
}

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Day grouping (Today, held, travel days) is local-calendar based, so a fixture
// built from the live clock flips sections when the run straddles midnight.
// Every test runs at one fixed local mid-day instant instead.
beforeEach(() => {
	setSystemTime(new Date(NOW));
});
afterEach(() => {
	setSystemTime();
});
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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function rows(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>("[data-flight-key]")];
}

function row(container: HTMLElement, key: string): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		`[data-flight-key="${key}"]`
	);
	if (!found) {
		throw new Error(`No row ${key}`);
	}
	return found;
}

/** Presses a key; true when nothing prevented its default action. */
async function press(target: HTMLElement, key: string): Promise<boolean> {
	let notPrevented = true;
	await act(async () => {
		notPrevented = target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
	return notPrevented;
}

describe("departures model", () => {
	const SNAPSHOT = fixture(NOW);

	test("gives every agent a unique two-letter airline code", () => {
		const codes = airlineCodes(SNAPSHOT.agents);
		expect(codes.get("agent-ada")).toBe("AD");
		expect(codes.get("agent-adam")).toBe("AA");
		expect(flightNumber("AD", "thread-live")).toMatch(/^AD \d{4}$/);
		expect(flightNumber("AD", "thread-live")).toBe(
			flightNumber("AD", "thread-live")
		);
	});

	test("puts each thread on the board and status its state implies", () => {
		const boards = buildBoards(SNAPSHOT, NOW);
		const status = (key: string) =>
			[...boards.departures, ...boards.arrivals].find(
				(flight) => flight.key === key
			)?.status;
		expect(status("thread:thread-live")).toBe("in-flight");
		expect(status("thread:thread-asked")).toBe("boarding");
		expect(status("thread:thread-fresh")).toBe("landed");
		expect(status("thread:thread-gate")).toBe("at-gate");
		expect(status("thread:thread-failed")).toBe("delayed");
		// A reply left a day still waits on you: at the gate, lamp dimmed.
		expect(status("thread:thread-old")).toBe("at-gate");
		expect(status("event:event-next")).toBe("scheduled");
		expect(boards.departures.map((flight) => flight.key)).toEqual([
			"thread:thread-asked",
			"thread:thread-live",
			"event:event-next",
		]);
		// Arrivals: latest landing first.
		expect(boards.arrivals.map((flight) => flight.key)).toEqual([
			"thread:thread-fresh",
			"thread:thread-failed",
			"thread:thread-gate",
			"event:event-past",
			"thread:thread-old",
		]);
		const old = boards.arrivals.find(
			(flight) => flight.key === "thread:thread-old"
		);
		expect(old?.parked).toBe(true);
		expect(boardForThread(boards, "thread-gate")).toBe("arrivals");
		expect(boardForThread(boards, "missing")).toBe(null);
	});

	test("lands the latest past run of each routine on Arrivals", () => {
		const failed: InterfaceEvent = {
			agentId: "agent-adam",
			end: new Date(NOW - 2 * HOUR).toISOString(),
			id: "event-audit",
			kind: "past",
			label: "Every Monday at 9 AM",
			outcome: "failure",
			start: new Date(NOW - 2.1 * HOUR).toISOString(),
			title: "Dependency audit",
		};
		const olderFailure: InterfaceEvent = {
			...failed,
			end: new Date(NOW - 50 * HOUR).toISOString(),
			id: "event-backup-failed",
			outcome: "failure",
			start: new Date(NOW - 50.1 * HOUR).toISOString(),
			agentId: "agent-ada",
			title: "Backup check",
		};
		const boards = buildBoards(
			{
				...SNAPSHOT,
				events: [...(SNAPSHOT.events ?? []), failed, olderFailure],
			},
			NOW
		);
		const audit = boards.arrivals.find(
			(flight) => flight.key === "event:event-audit"
		);
		expect(audit?.status).toBe("delayed");
		expect(audit?.remark).toBe("Run failed");
		expect(
			audit && flightTimeline(audit, NOW).map((step) => step.label)
		).toEqual(["Departed", "Delayed", "Rebook"]);
		// A later success supersedes the older failure of the same routine.
		const backups = boards.arrivals.filter(
			(flight) => flight.title === "Backup check"
		);
		expect(backups.map((flight) => flight.key)).toEqual(["event:event-past"]);
		expect(backups[0]?.status).toBe("arrived");
		expect(backups[0]?.remark).toBe("Done · Ran 12m");
	});

	test("every arrival carries a remark, with its age where it waits on you", () => {
		const boards = buildBoards(SNAPSHOT, NOW);
		const remark = (key: string) =>
			boards.arrivals.find((flight) => flight.key === key)?.remark;
		expect(remark("thread:thread-fresh")).toBe("Your turn · 10m");
		expect(remark("thread:thread-gate")).toBe("Your turn · 2h");
		expect(remark("thread:thread-old")).toBe("Reply waiting · 1d 6h");
	});

	test("estimates arrival from real run lengths, labelled as an estimate", () => {
		expect(typicalFlightMs(SNAPSHOT, "agent-ada")).toBe(12 * MINUTE);
		// Adam has no finished runs, so every agent's runs stand in.
		expect(typicalFlightMs(SNAPSHOT, "agent-adam")).toBe(12 * MINUTE);
		expect(typicalFlightMs({ ...SNAPSHOT, events: [] }, "agent-ada")).toBe(
			null
		);
		const live = buildBoards(SNAPSHOT, NOW).departures.find(
			(flight) => flight.threadId === "thread-live"
		);
		expect(live?.etaAt).toBe(NOW + 7 * MINUTE);
		expect(live?.remark).toBe(
			`ETA ${boardTime(NOW + 7 * MINUTE)} est. · Airborne 5m`
		);
		expect(live && flightProgress(live, NOW)).toBeCloseTo(5 / 12);
		const noEstimate = buildBoards(
			{ ...SNAPSHOT, events: [] },
			NOW
		).departures.find((flight) => flight.threadId === "thread-live");
		expect(noEstimate?.etaAt).toBe(null);
		expect(noEstimate?.remark).toBe("Airborne 5m");
	});

	test("a live run is in flight from the start; one past its estimate says so", () => {
		const justLeft = buildBoards(SNAPSHOT, NOW - 4.5 * MINUTE).departures.find(
			(flight) => flight.threadId === "thread-live"
		);
		expect(justLeft?.status).toBe("in-flight");
		const overdue = buildBoards(SNAPSHOT, NOW + 30 * MINUTE).departures.find(
			(flight) => flight.threadId === "thread-live"
		);
		expect(overdue?.remark).toContain("Longer than usual");
	});

	test("heads later days with a divider and holds stale boarding last", () => {
		const stale: InterfaceThread = {
			agentIds: [],
			id: "thread-stale",
			lastMessage: null,
			lastMessageRole: "user",
			messageCount: 1,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Office closed Friday",
			updatedAt: new Date(NOW - 9 * 24 * HOUR).toISOString(),
		};
		const tomorrow: InterfaceEvent = {
			agentId: "agent-adam",
			id: "event-tomorrow",
			kind: "upcoming",
			label: "Weekdays at 9 AM",
			start: new Date(NOW + 24 * HOUR).toISOString(),
			title: "Standup summary",
		};
		const boards = buildBoards(
			{
				...SNAPSHOT,
				events: [...(SNAPSHOT.events ?? []), tomorrow],
				threads: [stale, ...SNAPSHOT.threads],
			},
			NOW
		);
		const departures = boards.departures;
		expect(departures.at(-1)?.key).toBe("thread:thread-stale");
		expect(departures.at(-1)?.section.key).toBe("held");
		expect(departures.at(-1)?.remarkParts[0]).toEqual({
			emphasis: true,
			text: "No gate assigned",
		});
		const next = departures.find(
			(flight) => flight.key === "event:event-tomorrow"
		);
		expect(next?.section.label).toStartWith("Tomorrow · ");
		expect(next && flightAccessibleName(next)).toContain(
			boardDate(NOW + 24 * HOUR)
		);
		expect(departures[0]?.section.key).toBe("today");
	});

	test("lays out a timeline the snapshot can back", () => {
		const boards = buildBoards(SNAPSHOT, NOW);
		const live = boards.departures.find(
			(flight) => flight.threadId === "thread-live"
		);
		const steps = live ? flightTimeline(live, NOW) : [];
		expect(steps.map((step) => step.label)).toEqual([
			"Departed",
			"Airborne",
			"ETA",
		]);
		expect(steps.at(-1)?.time).toBe(`${boardTime(NOW + 7 * MINUTE)} est.`);
		expect(steps.at(-1)?.detail).toBe("Estimated from recent runs");
		const gate = boards.arrivals.find(
			(flight) => flight.threadId === "thread-gate"
		);
		expect(gate && flightTimeline(gate, NOW).map((step) => step.label)).toEqual(
			["Landed", "At gate"]
		);
	});

	test("a conversation with no messages never shows a landing", () => {
		const blank: InterfaceThread = {
			agentIds: [],
			id: "thread-blank",
			lastMessage: null,
			lastMessageRole: null,
			messageCount: 0,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Blank",
			updatedAt: new Date(NOW - 12 * MINUTE).toISOString(),
		};
		const flight = buildBoards({ ...SNAPSHOT, threads: [blank] }, NOW)
			.arrivals[0];
		expect(flight?.quiet).toBeTrue();
		const steps = flight ? flightTimeline(flight, NOW) : [];
		expect(steps.map((step) => step.label)).toEqual(["Not started"]);
		expect(steps.some((step) => step.detail?.includes("On the ground"))).toBe(
			false
		);
	});

	test("names rows for assistive tech and moves the cursor", () => {
		const flight = buildBoards(SNAPSHOT, NOW).arrivals[0];
		expect(flight && flightAccessibleName(flight)).toContain(
			"to Palette options"
		);
		expect(flightDuration(90 * MINUTE)).toBe("1h 30m");
		expect(flightDuration(30_000)).toBe("30s");
		expect(nextRowIndex("ArrowDown", 0, 3)).toBe(1);
		expect(nextRowIndex("ArrowDown", 2, 3)).toBe(2);
		expect(nextRowIndex("ArrowUp", 0, 3)).toBe(0);
		expect(nextRowIndex("End", 0, 3)).toBe(2);
		expect(nextRowIndex("x", 0, 3)).toBe(null);
		expect(nextRowIndex("ArrowDown", 0, 0)).toBe(null);
	});
});

describe("DeparturesInterface", () => {
	test("renders the board, and its loading and empty states", () => {
		const { port } = recordingPort();
		const snapshot = fixture(NOW);
		const markup = renderToStaticMarkup(
			<DeparturesInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="interface-departures"');
		expect(markup).toContain('role="grid"');
		expect(markup).toContain("Destination");
		const loading = renderToStaticMarkup(
			<DeparturesInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...snapshot, threads: [] }}
				threadView={null}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain('role="grid"');
		const empty = renderToStaticMarkup(
			<DeparturesInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...snapshot, agents: [], events: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(empty).toContain("No departures");
		expect(empty).not.toContain('role="grid"');
	});

	test("opens a flight with a click or Enter, and switches boards with the arrows", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeparturesInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(NOW)}
				threadView={null}
			/>
		);
		const { container } = view;
		await act(async () => row(container, "thread:thread-live").click());
		expect(calls).toEqual(["open:thread-live"]);

		// The opened flight is the board's one tab stop.
		const tabStops = rows(container).filter((item) => item.tabIndex === 0);
		expect(tabStops.map((item) => item.dataset.flightKey)).toEqual([
			"thread:thread-live",
		]);
		const live = row(container, "thread:thread-live");
		await act(async () => live.focus());
		await press(live, "ArrowUp");
		expect(document.activeElement?.getAttribute("data-flight-key")).toBe(
			"thread:thread-asked"
		);
		await press(document.activeElement as HTMLElement, "Enter");
		expect(calls.at(-1)).toBe("open:thread-asked");

		// Tab is left to the browser, so focus can leave the board.
		const tabbed = await press(document.activeElement as HTMLElement, "Tab");
		expect(tabbed).toBe(true);
		expect(rows(container).map((item) => item.dataset.flightKey)).toContain(
			"thread:thread-live"
		);

		await press(document.activeElement as HTMLElement, "ArrowRight");
		expect(rows(container).map((item) => item.dataset.flightKey)).toContain(
			"thread:thread-gate"
		);
		expect(
			container.querySelector('[data-flight-key="thread:thread-live"]')
		).toBe(null);

		// The masthead title is the board switch.
		const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
		expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
			"false",
			"true",
		]);
		await act(async () => tabs[0]?.click());
		expect(rows(container).map((item) => item.dataset.flightKey)).toContain(
			"thread:thread-live"
		);
		// Down from a focused tab drops into the rows at the cursor.
		const departuresTab = tabs[0];
		if (!departuresTab) {
			throw new Error("Expected the Departures tab");
		}
		await act(async () => departuresTab.focus());
		await press(departuresTab, "ArrowDown");
		expect(document.activeElement?.getAttribute("role")).toBe("row");
		expect(departuresTab.getAttribute("aria-describedby")).toBeTruthy();
		await view.dispose();
	});

	test("shows the host's thread view in the flight details panel and closes with Escape", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeparturesInterface
				activeThreadId="thread-gate"
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(NOW)}
				threadView={<p data-testid="host-thread">Host chat</p>}
			/>
		);
		const { container } = view;
		const panel = container.querySelector('[data-testid="departures-panel"]');
		expect(panel?.querySelector('[data-testid="host-thread"]')).not.toBe(null);
		expect(panel?.textContent).toContain("Release notes");
		expect(panel?.textContent).toContain("At gate");
		// The host's thread is on Arrivals, so that board is showing.
		expect(
			row(container, "thread:thread-gate").getAttribute("aria-current")
		).toBe("true");
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("opening a routine run over an open conversation closes it for the run", async () => {
		const { calls, port } = recordingPort();
		const props = { loading: false, params: {}, port, snapshot: fixture(NOW) };
		const view = await mount(
			<DeparturesInterface
				{...props}
				activeThreadId="thread-gate"
				threadView={<p data-testid="host-thread">Host chat</p>}
			/>
		);
		const { container } = view;
		const run = row(container, "event:event-past");
		await act(async () => run.focus());
		await press(run, "Enter");
		expect(calls).toEqual(["close"]);
		// The host follows by dropping its thread; the run's timeline shows.
		await view.rerender(
			<DeparturesInterface {...props} activeThreadId={null} threadView={null} />
		);
		const panel = container.querySelector('[data-testid="departures-panel"]');
		expect(panel?.querySelector('[data-testid="host-thread"]')).toBe(null);
		expect(panel?.textContent).toContain("Backup check");
		await view.dispose();
	});

	test("Book a flight opens the booking form in the panel and sends only on submit", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeparturesInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(NOW)}
				threadView={null}
			/>
		);
		const { container } = view;
		const button = [...container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent === "Book a flight"
		);
		await act(async () => button?.click());
		const panel = container.querySelector('[data-testid="departures-panel"]');
		expect(panel?.getAttribute("aria-label")).toBe("Book a flight");
		expect(document.activeElement?.tagName).toBe("TEXTAREA");
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("a scheduled run opens its details and books a flight with that gate", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeparturesInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(NOW)}
				threadView={null}
			/>
		);
		const { container } = view;
		const scheduled = row(container, "event:event-next");
		await act(async () => scheduled.focus());
		await press(scheduled, "Enter");
		const panel = container.querySelector('[data-testid="departures-panel"]');
		expect(panel?.textContent).toContain("Daily at 6 AM");
		const field = panel?.querySelector("textarea");
		const form = panel?.querySelector("form");
		if (!(field && form)) {
			throw new Error("Expected the booking form");
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			field.focus();
			setValue?.call(field, "Run the backup check now");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await act(async () => {
			form.requestSubmit();
		});
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Run the backup check now" })}`,
		]);
		// Nothing is sent before the user submits.
		expect(calls.length).toBe(1);
		await view.dispose();
	});
});
