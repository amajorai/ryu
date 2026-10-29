import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackingInterface } from "./tracking-interface.tsx";
import {
	buildParcels,
	expectedLine,
	matchesQuery,
	rowWhen,
	scheduleLabel,
	stepStates,
	tabCounts,
	trackingHistory,
	trackingNumber,
	trackingStage,
} from "./tracking-model.ts";

const MINUTE = 60_000;
const NOW = Date.now();
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

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-atlas",
		end: null,
		id: "event-next",
		kind: "upcoming",
		label: "Daily at 9 AM",
		start: ahead(90),
		title: "Morning digest",
	},
	{
		agentId: "agent-atlas",
		end: ago(299),
		id: "event-past",
		kind: "past",
		label: "Daily at 9 AM",
		outcome: "success",
		start: ago(300),
		title: "Morning digest",
	},
];

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Research",
			id: "agent-atlas",
			name: "Atlas",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Engineer",
			id: "agent-forge",
			name: "Forge",
			status: "working",
		},
	],
	events: EVENTS,
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-forge"],
			name: "Website Redesign",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-forge"],
			id: "thread-hero",
			lastMessage: "Preloading the font now.",
			projectId: "project-site",
			running: true,
			title: "Rebuild the landing hero",
			updatedAt: ago(1),
		}),
		thread({
			agentIds: ["agent-forge"],
			id: "thread-deploy",
			running: true,
			title: "Roll out gateway",
			updatedAt: ago(9),
		}),
		thread({
			agentIds: ["agent-atlas"],
			id: "thread-notes",
			lastMessage: "Draft is ready.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-atlas"],
			id: "thread-audit",
			runState: "failed",
			title: "Audit lockfile",
			updatedAt: ago(95),
		}),
		thread({
			agentIds: ["agent-atlas"],
			id: "thread-question",
			lastMessage: "Can you compare latency?",
			lastMessageRole: "user",
			title: "Survey papers",
			updatedAt: ago(420),
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

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(element) =>
			element.getAttribute("aria-label") === label ||
			element.textContent?.trim() === label
	);
}

function tab(container: HTMLElement, label: string) {
	return [...container.querySelectorAll('[role="tab"]')].find((element) =>
		element.textContent?.startsWith(label)
	);
}

function row(container: HTMLElement, threadId: string) {
	return container.querySelector(`[data-thread-id="${threadId}"]`);
}

function headline(container: HTMLElement) {
	return container.querySelector('[data-testid="tracking-page"] h1')
		?.textContent;
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

/** A tiny host: opening a thread shows a stub threadView, closing hides it. */
function Host({
	initial = null,
	port,
	snapshot = SNAPSHOT,
}: {
	initial?: string | null;
	port: InterfacePort;
	snapshot?: InterfaceSnapshot;
}) {
	const [openId, setOpenId] = useState<string | null>(initial);
	const view: ReactNode = openId ? (
		<div data-testid="host-thread">{openId}</div>
	) : null;
	return (
		<TrackingInterface
			activeThreadId={openId}
			loading={false}
			params={{}}
			port={{
				closeThread: () => {
					port.closeThread();
					setOpenId(null);
				},
				openThread: (id) => {
					port.openThread(id);
					setOpenId(id);
				},
				startThread: port.startThread,
			}}
			snapshot={snapshot}
			threadView={view}
		/>
	);
}

describe("tracking model", () => {
	test("tracking numbers are stable and carrier-shaped", () => {
		const first = trackingNumber("thread-hero");
		expect(first).toMatch(/^RY \d{4} \d{4} \d{2}$/);
		expect(trackingNumber("thread-hero")).toBe(first);
		expect(trackingNumber("thread-deploy")).not.toBe(first);
	});

	test("stages follow thread status, with out-for-delivery inferred from recency", () => {
		const [hero, deploy, notes, audit, question] = SNAPSHOT.threads;
		if (!(hero && deploy && notes && audit && question)) {
			throw new Error("fixture");
		}
		expect(trackingStage(hero, NOW)).toBe("out");
		expect(trackingStage(deploy, NOW)).toBe("transit");
		expect(trackingStage(notes, NOW)).toBe("delivered");
		expect(trackingStage(audit, NOW)).toBe("exception");
		expect(trackingStage(question, NOW)).toBe("awaiting");
		expect(
			trackingStage(thread({ id: "empty", lastMessageRole: null }), NOW)
		).toBe("label");
	});

	test("your own fresh message never reads as out for delivery", () => {
		const justSent = thread({
			agentIds: ["agent-forge"],
			id: "thread-new",
			lastMessage: "Draft a launch banner",
			lastMessageRole: "user",
			running: true,
			updatedAt: ago(0),
		});
		expect(trackingStage(justSent, NOW)).toBe("transit");
		const [parcel] = buildParcels({ ...SNAPSHOT, threads: [justSent] }, NOW);
		if (!parcel) {
			throw new Error("fixture");
		}
		const latest = trackingHistory(parcel, [], NOW)
			.flatMap((group) => group.entries)
			.find((entry) => entry.id === "latest");
		expect(latest?.detail).toBeNull();

		const [waiting] = buildParcels(
			{ ...SNAPSHOT, threads: [{ ...justSent, running: false }] },
			NOW
		);
		const waitingLatest = waiting
			? trackingHistory(waiting, [], NOW)
					.flatMap((group) => group.entries)
					.find((entry) => entry.id === "latest")
			: undefined;
		expect(waitingLatest?.detail).toBe("You: Draft a launch banner");
	});

	test("a message with no courier is a label, listed only under All", () => {
		const loose = thread({
			id: "thread-loose",
			lastMessage: "Office closed Friday",
			lastMessageRole: "user",
		});
		const parcels = buildParcels({ ...SNAPSHOT, threads: [loose] }, NOW);
		expect(parcels[0]?.stage).toBe("label");
		expect(tabCounts(parcels)).toEqual({
			all: 1,
			delivered: 0,
			exceptions: 0,
			"on-the-way": 0,
		});
	});

	test("the stepper marks done, current and exception steps", () => {
		expect(stepStates("delivered")).toEqual([
			"done",
			"done",
			"done",
			"done",
			"done",
		]);
		expect(stepStates("exception")).toEqual([
			"done",
			"done",
			"exception",
			"upcoming",
			"upcoming",
		]);
		expect(stepStates("awaiting")).toEqual([
			"done",
			"current",
			"upcoming",
			"upcoming",
			"upcoming",
		]);
	});

	test("tabs count every parcel once and search matches unspaced numbers", () => {
		const parcels = buildParcels(SNAPSHOT, NOW);
		expect(tabCounts(parcels)).toEqual({
			all: 5,
			delivered: 1,
			exceptions: 1,
			"on-the-way": 3,
		});
		const hero = parcels.find((parcel) => parcel.thread.id === "thread-hero");
		if (!hero) {
			throw new Error("fixture");
		}
		expect(matchesQuery(hero, hero.number.replaceAll(" ", ""))).toBe(true);
		expect(matchesQuery(hero, "website")).toBe(true);
		expect(matchesQuery(hero, "forge")).toBe(true);
		expect(matchesQuery(hero, "atlas")).toBe(false);
	});

	test("copy only prints known times and marks estimates", () => {
		const parcels = buildParcels(SNAPSHOT, NOW);
		const byId = (id: string) => {
			const parcel = parcels.find((item) => item.thread.id === id);
			if (!parcel) {
				throw new Error(id);
			}
			return parcel;
		};
		expect(expectedLine(byId("thread-hero"), EVENTS, NOW)).toContain(
			"estimated"
		);
		expect(expectedLine(byId("thread-deploy"), EVENTS, NOW)).toBe(
			"Expected when Forge finishes the current run"
		);
		expect(expectedLine(byId("thread-question"), EVENTS, NOW)).toContain(
			"Estimated pickup"
		);
		const waiting = trackingHistory(byId("thread-question"), EVENTS, NOW);
		expect(waiting[0]?.id).toBe("upcoming");
		expect(waiting[0]?.entries[0]?.title).toContain("'s next routine · ");
		expect(rowWhen(byId("thread-question"), NOW, EVENTS)).toMatch(
			/^Pickup .+ est\.$/
		);
		expect(rowWhen(byId("thread-notes"), NOW, EVENTS)).toMatch(/^Delivered /);

		// A delivered parcel never shows the courier's routines as scans.
		const history = trackingHistory(byId("thread-notes"), EVENTS, NOW);
		expect(history.some((group) => group.id === "upcoming")).toBe(false);
		expect(
			history
				.flatMap((group) => group.entries)
				.some((entry) => entry.id.startsWith("event-"))
		).toBe(false);
		const earlier = history.find((group) => group.id === "earlier");
		expect(earlier?.entries.every((entry) => entry.at === null)).toBe(true);
		const timed = history
			.filter((group) => group.id !== "earlier")
			.flatMap((group) => group.entries);
		expect(timed.every((entry) => entry.at !== null)).toBe(true);
		expect(
			timed.some((entry) => entry.title === "Delivered: Atlas replied")
		).toBe(true);
	});
});

describe("tracking schedule labels", () => {
	test("a schedule phrase is kept only when it agrees with the run time", () => {
		const nineAm = new Date(2026, 9, 12, 9, 0);
		const sevenPm = new Date(2026, 9, 12, 19, 16);
		expect(scheduleLabel("Weekdays at 9 AM", nineAm)).toBe("Weekdays at 9 AM");
		expect(scheduleLabel("Weekdays at 9 AM", sevenPm)).toBeNull();
		expect(scheduleLabel("Daily at 7:16 pm", sevenPm)).toBe("Daily at 7:16 pm");
		expect(scheduleLabel("Hourly", sevenPm)).toBe("Hourly");
		expect(scheduleLabel(null, sevenPm)).toBeNull();
	});

	test("upcoming runs are marked as estimates", () => {
		const parcels = buildParcels(SNAPSHOT, NOW);
		const question = parcels.find(
			(item) => item.thread.id === "thread-question"
		);
		if (!question) {
			throw new Error("fixture");
		}
		const [upcoming] = trackingHistory(question, EVENTS, NOW);
		expect(upcoming?.entries.every((entry) => entry.estimated)).toBe(true);
	});
});

describe("TrackingInterface", () => {
	test("renders the deliveries list and the selected parcel's tracking page", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<TrackingInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-tracking"');
		expect(html).toContain("My deliveries");
		expect(html).toContain("On the way");
		expect(html).toContain(trackingNumber("thread-hero"));
		expect(html).toContain("Out for delivery");
		expect(html).toContain("Tracking history");
		expect(html).toContain('data-testid="tracking-route"');
		expect(html).toContain('data-testid="tracking-van"');
		// The van rides the route once; the stepper nodes stay plain.
		expect(html.split('data-testid="tracking-van"').length).toBe(2);
		// Every step keeps its label in the markup at any width.
		expect(html).not.toContain("@md:block hidden");
		for (const step of ["Order placed", "Picked up", "In transit"]) {
			expect(html).toContain(`${step}<span class="sr-only">: Done</span>`);
		}
	});

	test("shows skeletons while loading and the send form when there is nothing to track", () => {
		const { port } = recordingPort();
		const loadingHtml = renderToStaticMarkup(
			<TrackingInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, threads: [] }}
				threadView={null}
			/>
		);
		expect(loadingHtml).toContain('aria-busy="true"');
		expect(loadingHtml).not.toContain("tracking-send");
		expect(loadingHtml).toContain('data-testid="tracking-page-skeleton"');

		const emptyHtml = renderToStaticMarkup(
			<TrackingInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(emptyHtml).toContain('data-testid="tracking-send"');
		expect(emptyHtml).toContain("No couriers yet");
	});

	test("rows select parcels, tabs filter, and arrows move between rows", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<Host port={port} />);
		expect(headline(view.container)).toBe("Out for delivery");

		await click(row(view.container, "thread-deploy"));
		expect(headline(view.container)).toBe("In transit");
		expect(calls).toEqual([]);

		const list = view.container.querySelector("ul[aria-label]");
		const deployRow = row(view.container, "thread-deploy");
		if (!(list && deployRow instanceof HTMLElement)) {
			throw new Error("list");
		}
		deployRow.focus();
		await press(deployRow, "ArrowDown");
		expect(headline(view.container)).toBe("Awaiting pickup");

		await click(tab(view.container, "Exceptions"));
		expect(row(view.container, "thread-hero")).toBeNull();
		expect(headline(view.container)).toBe("Delivery exception");

		const activeTab = tab(view.container, "Exceptions");
		if (!activeTab) {
			throw new Error("tab");
		}
		await press(activeTab, "ArrowRight");
		expect(tab(view.container, "All")?.getAttribute("aria-selected")).toBe(
			"true"
		);
		await view.dispose();
	});

	test("search narrows the current tab, keeps the page, and clears", async () => {
		const { port } = recordingPort();
		const view = await mount(<Host port={port} />);
		const field = view.container.querySelector<HTMLInputElement>(
			'input[inputmode="search"]'
		);
		if (!field) {
			throw new Error("search");
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		await act(async () => {
			field.focus();
			setValue?.call(field, "release");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		expect(tab(view.container, "On the way")?.textContent).toBe("On the way0");
		expect(tab(view.container, "Delivered")?.textContent).toBe("Delivered1");
		expect(headline(view.container)).toBe("Out for delivery");
		await click(button(view.container, "Show 1 in Delivered"));
		expect(
			tab(view.container, "Delivered")?.getAttribute("aria-selected")
		).toBe("true");
		expect(row(view.container, "thread-notes")).not.toBeNull();

		await click(button(view.container, "Clear search"));
		expect(field.value).toBe("");
		expect(tab(view.container, "On the way")?.textContent).toBe("On the way3");
		await view.dispose();
	});

	test("a manual pick survives snapshot pushes while another thread is open", async () => {
		const { port } = recordingPort();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(<Host initial="thread-hero" port={port} />)
		);
		expect(headline(container)).toBe("Out for delivery");

		await click(tab(container, "Exceptions"));
		await click(row(container, "thread-audit"));
		expect(headline(container)).toBe("Delivery exception");

		await act(async () =>
			root.render(
				<Host
					initial="thread-hero"
					port={port}
					snapshot={{ ...SNAPSHOT, threads: [...SNAPSHOT.threads] }}
				/>
			)
		);
		expect(headline(container)).toBe("Delivery exception");
		expect(tab(container, "Exceptions")?.getAttribute("aria-selected")).toBe(
			"true"
		);
		await act(async () => root.unmount());
		container.remove();
	});

	test("View conversation and Reschedule open the host thread view; Esc closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<Host port={port} />);
		await click(button(view.container, "View conversation"));
		expect(calls).toEqual(["open:thread-hero"]);
		expect(
			view.container.querySelector('[data-testid="host-thread"]')?.textContent
		).toBe("thread-hero");
		expect(
			view.container.querySelector('[data-testid="tracking-thread-panel"]')
		).not.toBeNull();
		// The panel is the open state: the page does not offer to open it again.
		expect(button(view.container, "View conversation")).toBeUndefined();

		await press(document.body, "Escape");
		expect(calls).toEqual(["open:thread-hero", "close"]);
		expect(
			view.container.querySelector('[data-testid="host-thread"]')
		).toBeNull();

		await click(tab(view.container, "Exceptions"));
		expect(button(view.container, "View conversation")).toBeUndefined();
		await click(button(view.container, "Reschedule"));
		expect(calls.at(-1)).toBe("open:thread-audit");
		await click(button(view.container, "Close conversation"));
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("Send a parcel starts a thread only with the prompt the user submitted", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<Host port={port} />);
		await click(button(view.container, "Send a parcel"));
		expect(
			view.container.querySelector('[data-testid="tracking-send"]')
		).not.toBeNull();
		expect(calls).toEqual([]);
		// The list no longer claims a parcel page is open.
		expect(view.container.querySelector('[aria-current="true"]')).toBeNull();

		const forge = view.container.querySelector<HTMLInputElement>(
			'input[type="radio"][value="agent-forge"]'
		);
		await click(forge);
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("composer");
		}
		await typeInto(field, "  Check the pricing copy  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-forge", prompt: "Check the pricing copy" })}`,
		]);
		await view.dispose();
	});
});
