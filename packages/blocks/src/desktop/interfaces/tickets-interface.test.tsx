// Static markup (react-dom/server) covers what the Tickets renderer prints;
// happy-dom with createRoot covers interactions, so clicks and keys run real
// React handlers against a port that records what it was asked to do.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketsInterface } from "./tickets-interface.tsx";
import {
	buildTickets,
	compactDuration,
	EMPTY_TICKET_FILTER,
	groupTickets,
	matchesTicketQuery,
	requesterTickets,
	sortTickets,
	TICKET_ATTENTION_HINT,
	TICKET_STATUS_HINTS,
	ticketActivity,
	ticketNumbers,
	ticketPriorityOf,
	ticketSla,
	ticketStatusHint,
	ticketStatusOf,
	ticketTag,
	ticketTimeLabel,
	ticketViewCounts,
	ticketViewRows,
} from "./tickets-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Renders read the wall clock, so fixtures are relative to the real now.
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
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website Redesign",
		},
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Docs Crew",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-site",
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
			running: true,
			teamId: "team-docs",
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
			agentIds: ["agent-ada"],
			id: "thread-old",
			lastMessage: "Done, the guide is in the docs folder.",
			title: "Style guide",
			updatedAt: ago(60 * 30),
		}),
		thread({
			id: "thread-blank",
			lastMessageRole: null,
			messageCount: 0,
			title: "Blank ticket",
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
// Base UI waits on animations, which happy-dom does not model.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

interface PortCalls {
	calls: string[];
	port: InterfacePort;
}

function recordingPort(): PortCalls {
	const calls: string[] = [];
	return {
		calls,
		port: {
			closeThread: () => calls.push("close"),
			openThread: (threadId) => calls.push(`open:${threadId}`),
			startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
		},
	};
}

function render({
	activeThreadId = null,
	loading = false,
	port = recordingPort().port,
	snapshot = SNAPSHOT,
	threadView = null,
}: {
	activeThreadId?: string | null;
	loading?: boolean;
	port?: InterfacePort;
	snapshot?: InterfaceSnapshot;
	threadView?: ReactNode;
} = {}): ReactElement {
	return (
		<TicketsInterface
			activeThreadId={activeThreadId}
			loading={loading}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

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

async function press(target: EventTarget, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

async function typeInto(field: HTMLTextAreaElement, value: string) {
	let proto: object | null = Object.getPrototypeOf(field);
	let setValue: ((this: HTMLTextAreaElement, next: string) => void) | undefined;
	while (proto && !setValue) {
		setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function rowIds(container: Element): string[] {
	return [...container.querySelectorAll("[data-testid^='tickets-row-']")].map(
		(row) => row.getAttribute("data-testid")?.replace("tickets-row-", "") ?? ""
	);
}

describe("tickets model", () => {
	test("maps thread status onto the help-desk lifecycle", () => {
		const statuses = Object.fromEntries(
			SNAPSHOT.threads.map((item) => [item.id, ticketStatusOf(item, NOW)])
		);
		expect(statuses).toEqual({
			"thread-blank": "new",
			"thread-flaky": "open",
			"thread-notes": "open",
			"thread-old": "solved",
			"thread-question": "pending",
			"thread-triage": "pending",
		});
	});

	test("a failed run after the user's message does not claim the agent answered", () => {
		const failed = thread({
			id: "thread-failed",
			lastMessageRole: "user",
			runState: "failed",
		});
		const ticket = buildTickets({ ...SNAPSHOT, threads: [failed] }, NOW)[0];
		expect(ticket?.status).toBe("open");
		expect(ticket ? ticketStatusHint(ticket) : "").toBe(TICKET_ATTENTION_HINT);
		expect(
			ticketStatusHint({ status: "open", threadStatus: "your-turn" })
		).toBe(TICKET_STATUS_HINTS.open);
		const html = renderToStaticMarkup(
			render({ snapshot: { ...SNAPSHOT, threads: [failed] } })
		);
		expect(html).toContain(`title="${TICKET_ATTENTION_HINT}"`);
		expect(html).not.toContain(`title="${TICKET_STATUS_HINTS.open}"`);
	});

	test("failed runs are urgent, answers waiting on you are high", () => {
		expect(ticketPriorityOf("open", "attention")).toBe("urgent");
		expect(ticketPriorityOf("open", "your-turn")).toBe("high");
		expect(ticketPriorityOf("pending", "working")).toBe("normal");
		expect(ticketPriorityOf("new", "quiet")).toBe("normal");
		expect(ticketPriorityOf("solved", "your-turn")).toBe("low");
	});

	test("the SLA counts down while the ticket waits on you and pauses otherwise", () => {
		const updated = NOW - 95 * MINUTE;
		const breached = ticketSla("open", "urgent", updated, NOW);
		expect(breached?.state).toBe("breached");
		expect(breached?.label).toBe("-35m");
		expect(breached?.longLabel).toBe("Reply overdue by 35 minutes");

		const soon = ticketSla("open", "high", NOW - 160 * MINUTE, NOW);
		expect(soon?.state).toBe("due-soon");
		expect(soon?.label).toBe("1h");

		const fine = ticketSla("open", "high", NOW - 30 * MINUTE, NOW);
		expect(fine?.state).toBe("on-track");
		expect(fine?.label).toBe("3h");

		expect(ticketSla("pending", "normal", updated, NOW)).toBeNull();
		expect(ticketSla("solved", "low", updated, NOW)).toBeNull();
	});

	test("compact durations use the largest whole unit", () => {
		expect(compactDuration(20 * 1000)).toBe("1m");
		expect(compactDuration(-35 * MINUTE)).toBe("35m");
		expect(compactDuration(5 * HOUR)).toBe("5h");
		expect(compactDuration(50 * HOUR)).toBe("2d");
	});

	test("ticket numbers are four digits, stable, and unique", () => {
		const first = ticketNumbers(SNAPSHOT.threads);
		const again = ticketNumbers([...SNAPSHOT.threads].reverse());
		expect([...first.entries()].sort()).toEqual([...again.entries()].sort());
		for (const value of first.values()) {
			expect(value).toBeGreaterThanOrEqual(1000);
			expect(value).toBeLessThan(10_000);
		}
		const many = Array.from({ length: 600 }, (_, index) =>
			thread({ id: `thread-${index}` })
		);
		const numbers = ticketNumbers(many);
		expect(new Set(numbers.values()).size).toBe(600);
	});

	test("tags follow Zendesk's lowercase underscore form", () => {
		expect(ticketTag("Website Redesign")).toBe("website_redesign");
		expect(ticketTag("  Launch Crew! ")).toBe("launch_crew");
		const notes = buildTickets(SNAPSHOT, NOW).find(
			(ticket) => ticket.id === "thread-notes"
		);
		expect(notes?.tags).toEqual(["website_redesign"]);
		expect(notes?.requester?.name).toBe("Ada");
		expect(notes?.ccs.map((agent) => agent.name)).toEqual(["Grace"]);
	});

	test("views count what they match", () => {
		const tickets = buildTickets(SNAPSHOT, NOW);
		expect(ticketViewCounts(tickets, NOW)).toEqual({
			all: 6,
			open: 3,
			pending: 2,
			recent: 5,
			solved: 1,
			unsolved: 5,
			urgent: 1,
		});
	});

	test("rows group by status in lifecycle order and filter by query", () => {
		const tickets = buildTickets(SNAPSHOT, NOW);
		const rows = ticketViewRows(
			tickets,
			"unsolved",
			EMPTY_TICKET_FILTER,
			{ direction: "desc", key: "updated" },
			"status",
			NOW
		);
		expect(rows.sections.map((section) => section.label)).toEqual([
			"Status: New",
			"Status: Open",
			"Status: Pending",
		]);
		expect(rows.order).toEqual([
			"thread-blank",
			"thread-notes",
			"thread-flaky",
			"thread-triage",
			"thread-question",
		]);
		const flaky = tickets.find((ticket) => ticket.id === "thread-flaky");
		if (!flaky) {
			throw new Error("missing ticket");
		}
		expect(matchesTicketQuery(flaky, `#${flaky.number}`)).toBe(true);
		expect(matchesTicketQuery(flaky, "grace flaky")).toBe(true);
		expect(matchesTicketQuery(flaky, "ada")).toBe(false);
	});

	test("SLA sort keeps tickets without a running SLA last both ways", () => {
		const tickets = buildTickets(SNAPSHOT, NOW);
		for (const direction of ["asc", "desc"] as const) {
			const sorted = sortTickets(tickets, { direction, key: "sla" });
			const firstPaused = sorted.findIndex((ticket) => ticket.sla === null);
			expect(sorted.slice(firstPaused).every((ticket) => !ticket.sla)).toBe(
				true
			);
		}
		const ascending = sortTickets(tickets, { direction: "asc", key: "sla" });
		expect(ascending[0]?.id).toBe("thread-flaky");
	});

	test("grouping by priority follows urgency", () => {
		const sections = groupTickets(buildTickets(SNAPSHOT, NOW), "priority");
		expect(sections.map((section) => section.id)).toEqual([
			"urgent",
			"high",
			"normal",
			"low",
		]);
	});

	test("other tickets and activity come from what the snapshot knows", () => {
		const tickets = buildTickets(SNAPSHOT, NOW);
		const flaky = tickets.find((ticket) => ticket.id === "thread-flaky");
		if (!flaky) {
			throw new Error("missing ticket");
		}
		expect(requesterTickets(tickets, flaky).map((ticket) => ticket.id)).toEqual(
			["thread-triage"]
		);
		expect(ticketActivity(flaky, NOW).map((item) => item.id)).toEqual([
			"sla",
			"run",
			"reply",
		]);
		const triage = tickets.find((ticket) => ticket.id === "thread-triage");
		expect(triage && ticketActivity(triage, NOW)[0]?.id).toBe("running");
	});

	test("time labels read like a help desk", () => {
		expect(ticketTimeLabel(NOW - 20 * 1000, NOW)).toBe("Just now");
		expect(ticketTimeLabel(NOW - 18 * MINUTE, NOW)).toBe("18 min ago");
		expect(ticketTimeLabel(0, NOW)).toBe("");
		const noon = new Date(2026, 9, 14, 12, 0).getTime();
		expect(ticketTimeLabel(noon - 3 * HOUR, noon)).toStartWith("Today ");
		expect(ticketTimeLabel(noon - 24 * HOUR, noon)).toStartWith("Yesterday ");
	});
});

describe("tickets markup", () => {
	test("renders the views, the table and every status pill", () => {
		const html = renderToStaticMarkup(render());
		expect(html).toContain('data-testid="interface-tickets"');
		expect(html).toContain("Your unsolved tickets");
		expect(html).toContain("Status: Open");
		expect(html).toContain('data-status="new"');
		expect(html).toContain('data-status="pending"');
		expect(html).toContain('data-sla="breached"');
		expect(html).toContain("Urgent");
		expect(html).not.toContain("Style guide");
	});

	test("loading shows skeleton rows and no tickets", () => {
		const html = renderToStaticMarkup(
			render({ loading: true, snapshot: { ...SNAPSHOT, threads: [] } })
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("tickets-row-");
		expect(html).not.toContain("No tickets yet");
	});

	test("an empty workspace explains how tickets start", () => {
		const html = renderToStaticMarkup(
			render({ snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		expect(html).toContain("No tickets yet");
		expect(html).toContain("Add an agent");
		expect(html).toContain("New ticket");
	});

	test("an open ticket shows the host's conversation and the properties", () => {
		const html = renderToStaticMarkup(
			render({
				activeThreadId: "thread-flaky",
				threadView: <p>host chat surface</p>,
			})
		);
		expect(html).toContain('data-testid="tickets-page"');
		expect(html).toContain("host chat surface");
		expect(html).toContain("Flaky test");
		expect(html).toContain("Requested by");
		expect(html).toContain("Other tickets from Grace");
		expect(html).toContain("Reply overdue");
		expect(html).not.toContain('data-testid="tickets-table"');
	});
});

describe("tickets interactions", () => {
	test("clicking a row opens its thread through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		await click(
			view.container.querySelector("[data-testid='tickets-row-thread-flaky']")
		);
		expect(calls).toEqual(["open:thread-flaky"]);
		await view.dispose();
	});

	test("j/k move the cursor, Enter opens, x selects", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		const order = rowIds(view.container);
		await press(document.body, "j");
		await press(document.body, "j");
		await press(document.body, "k");
		expect(document.activeElement?.getAttribute("data-testid")).toBe(
			`tickets-row-${order[1]}`
		);
		await press(document.body, "x");
		expect(
			view.container.querySelector("[data-testid='tickets-bulk-bar']")
				?.textContent
		).toContain("1 selected");
		await press(document.body, "Escape");
		expect(
			view.container.querySelector("[data-testid='tickets-bulk-bar']")
		).toBeNull();
		await press(document.body, "Enter");
		expect(calls).toEqual([`open:${order[1]}`]);
		await view.dispose();
	});

	test("a host page over the help desk keeps its keys", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		// While the host covers the interface it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "j");
		await press(document.body, "Enter");
		await press(document.body, "o");
		await press(document.body, "c");
		expect(document.activeElement).toBe(document.body);
		expect(calls).toEqual([]);
		expect(
			view.container.querySelector("[data-testid='tickets-new-ticket']")
		).toBeNull();
		view.container.removeAttribute("inert");
		await press(document.body, "Enter");
		expect(calls).toEqual([`open:${rowIds(view.container)[0]}`]);
		await press(document.body, "j");
		expect(document.activeElement?.getAttribute("data-testid")).toMatch(
			/^tickets-row-/
		);
		await view.dispose();
	});

	test("bulk selection opens the selected tickets in tabs", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		const order = rowIds(view.container);
		await press(document.body, "x");
		await press(document.body, "j");
		await press(document.body, "x");
		const openInTabs = [...view.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Open in tabs"
		);
		await click(openInTabs);
		expect(calls).toEqual([`open:${order[0]}`]);
		await view.dispose();
	});

	test("views switch the table's tickets", async () => {
		const view = await mount(render());
		await click(
			view.container.querySelector("[data-testid='tickets-view-urgent']")
		);
		expect(rowIds(view.container)).toEqual(["thread-flaky"]);
		await click(
			view.container.querySelector("[data-testid='tickets-view-solved']")
		);
		expect(rowIds(view.container)).toEqual(["thread-old"]);
		await view.dispose();
	});

	test("a new ticket sends only the description the user submitted", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		await click(view.container.querySelector("[data-testid='tickets-new']"));
		expect(
			view.container.querySelector("[data-testid='tickets-new-ticket']")
		).not.toBeNull();
		expect(calls).toEqual([]);
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("missing description field");
		}
		await typeInto(field, "  Summarise the crash reports  ");
		const form = field.closest("form");
		await act(async () => {
			form?.requestSubmit();
		});
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Summarise the crash reports" })}`,
		]);
		expect(
			view.container.querySelector("[data-testid='tickets-new-ticket']")
		).toBeNull();
		await view.dispose();
	});

	test("a partial selection marks the select-all box as mixed", async () => {
		const view = await mount(render());
		const selectAll = () =>
			view.container.querySelector("[aria-label='Select all tickets in view']");
		expect(selectAll()?.getAttribute("aria-checked")).toBe("false");
		await press(document.body, "x");
		expect(selectAll()?.getAttribute("aria-checked")).toBe("mixed");
		await click(selectAll());
		expect(selectAll()?.getAttribute("aria-checked")).toBe("true");
		await view.dispose();
	});

	test("the new-ticket form labels its fields and needs a description", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(render({ port }));
		await press(document.body, "c");
		const page = view.container.querySelector(
			"[data-testid='tickets-new-ticket']"
		);
		const select = page?.querySelector("select");
		const label = select?.id
			? page?.querySelector(`label[for='${select.id}']`)
			: null;
		expect(label?.textContent).toBe("Requester");
		const field = page?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("missing description field");
		}
		const ctrlEnter = async () => {
			await act(async () => {
				field.dispatchEvent(
					new KeyboardEvent("keydown", {
						bubbles: true,
						cancelable: true,
						ctrlKey: true,
						key: "Enter",
					})
				);
			});
		};
		await ctrlEnter();
		expect(calls).toEqual([]);
		await typeInto(field, "Triage the open bugs");
		await ctrlEnter();
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Triage the open bugs" })}`,
		]);
		await view.dispose();
	});

	test("an open ticket gets a tab, and Escape closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			render({
				activeThreadId: "thread-notes",
				port,
				threadView: <p>chat</p>,
			})
		);
		expect(
			view.container.querySelector("[data-testid='tickets-tab-thread-notes']")
		).not.toBeNull();
		await press(document.body, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("keys typed inside the host's conversation stay there", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			render({
				activeThreadId: "thread-notes",
				port,
				threadView: <input aria-label="Message" />,
			})
		);
		const composer = view.container.querySelector(
			"[data-testid='tickets-thread-view'] input"
		);
		if (!composer) {
			throw new Error("missing composer");
		}
		await press(composer, "Escape");
		await press(composer, "c");
		expect(calls).toEqual([]);
		await view.dispose();
	});
});
