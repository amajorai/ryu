import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusInterface } from "./status-interface.tsx";
import {
	buildStatusPage,
	dayStarts,
	formatUptime,
	HISTORY_DAYS,
	UPTIME_DAYS,
	uptimeShare,
	worstState,
} from "./status-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

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

function event(
	input: Partial<InterfaceEvent> & Pick<InterfaceEvent, "id" | "start">
): InterfaceEvent {
	return {
		agentId: "agent-ada",
		kind: "past",
		label: "Daily at 6 AM",
		title: "Backup check",
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
			description: "Reviews dependencies",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: [
		// Failed, then succeeded the next day: resolved.
		event({ id: "backup-fail", outcome: "failure", start: at(-50) }),
		event({ id: "backup-ok", outcome: "success", start: at(-26) }),
		// Failed with no success since: still open.
		event({
			agentId: "agent-linus",
			id: "audit-fail",
			label: "Every Monday at 9 AM",
			outcome: "failure",
			start: at(-4),
			title: "Dependency audit",
		}),
		event({
			agentId: "agent-grace",
			count: 24,
			id: "sweep",
			kind: "upcoming",
			label: "Every hour",
			start: at(2),
			title: "Inbox sweep",
		}),
		event({
			agentId: null,
			id: "report",
			kind: "upcoming",
			label: "First of the month",
			start: at(1),
			title: "Usage report",
		}),
	],
	groups: [
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Docs Crew",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-linus"],
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
			agentIds: ["agent-grace"],
			id: "thread-triage",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The test runner timed out twice.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(6),
		}),
	],
	version: 1,
};

const CALM: InterfaceSnapshot = {
	...SNAPSHOT,
	events: [],
	threads: SNAPSHOT.threads.filter((item) => item.runState !== "failed"),
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
	};
}

function recordingPort(log: string[]): InterfacePort {
	return {
		closeThread: () => log.push("close"),
		openThread: (threadId) => log.push(`open:${threadId}`),
		startThread: (input) => log.push(`start:${JSON.stringify(input)}`),
	};
}

/** A tiny host: opens and closes threads in state, like the desktop does. */
function Host({
	initialThreadId = null,
	log,
	snapshot = SNAPSHOT,
}: {
	initialThreadId?: string | null;
	log: string[];
	snapshot?: InterfaceSnapshot;
}) {
	const [open, setOpen] = useState<string | null>(initialThreadId);
	const port: InterfacePort = {
		closeThread: () => {
			log.push("close");
			setOpen(null);
		},
		openThread: (threadId) => {
			log.push(`open:${threadId}`);
			setOpen(threadId);
		},
		startThread: (input) => log.push(`start:${JSON.stringify(input)}`),
	};
	return (
		<StatusInterface
			activeThreadId={open}
			loading={false}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={
				open ? <div data-testid="host-thread-view">thread {open}</div> : null
			}
		/>
	);
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Nothing to click");
	}
	await act(async () => {
		element.click();
	});
}

describe("status model", () => {
	test("teams group their members; agents outside a team follow", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		expect(page.sections.map((section) => section.group?.name ?? null)).toEqual(
			["Docs Crew", null]
		);
		expect(
			page.sections.map((section) =>
				section.components.map((component) => component.agent.name)
			)
		).toEqual([["Ada", "Grace"], ["Linus"]]);
	});

	test("components read degraded, working, or operational", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		const states = Object.fromEntries(
			page.sections
				.flatMap((section) => section.components)
				.map((component) => [component.agent.name, component.state])
		);
		// Grace is working, but a failed thread outranks a live run.
		expect(states).toEqual({
			Ada: "operational",
			Grace: "degraded",
			Linus: "degraded",
		});
		expect(page.sections[0]?.state).toBe("degraded");
	});

	test("open incidents are failed threads and unretried failed runs", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		expect(page.incidents.map((incident) => incident.id)).toEqual([
			"thread:thread-flaky",
			"run:audit-fail",
		]);
		const [flaky, audit] = page.incidents;
		expect(flaky?.threadId).toBe("thread-flaky");
		expect(flaky?.body).toBe("The test runner timed out twice.");
		expect(flaky?.affected).toEqual(["Grace"]);
		expect(audit?.threadId).toBeNull();
		expect(audit?.schedule).toBe("Every Monday at 9 AM");
		expect(page.overall).toBe("partial");
	});

	test("a later success resolves a failed run", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		const backup = page.history
			.flatMap((day) => day.incidents)
			.find((incident) => incident.id === "run:backup-fail");
		expect(backup?.stage).toBe("Resolved");
		expect(backup?.resolvedAt).toBe(at(-26));
		expect(page.incidents.some((incident) => incident.id === backup?.id)).toBe(
			false
		);
	});

	test("the banner follows how many components are affected", () => {
		expect(buildStatusPage(CALM, NOW).overall).toBe("operational");
		const one: InterfaceSnapshot = { ...SNAPSHOT, events: [] };
		expect(buildStatusPage(one, NOW).overall).toBe("degraded");
	});

	test("each component carries 30 days ending today, coloured by failures", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		const grace = page.sections[0]?.components[1];
		expect(grace?.days).toHaveLength(UPTIME_DAYS);
		const failing = grace?.days.filter((day) => day.problems.length > 0);
		// A failure alongside a live thread is a partial day, not an outage.
		expect(failing?.map((day) => day.level)).toEqual(["degraded"]);
		expect(failing?.[0]?.problems).toEqual(["Flaky test"]);
		expect(grace?.uptime).toBeLessThan(1);
		const ada = page.sections[0]?.components[0];
		expect(ada?.uptime).toBeLessThan(1);
		expect(ada?.days.filter((day) => day.level !== "operational")).toHaveLength(
			1
		);
	});

	test("uptime is a share of days, with partial days costing less", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		const days = page.sections[0]?.components[0]?.days ?? [];
		const clean = days.map((day) => ({
			...day,
			level: "operational" as const,
		}));
		expect(uptimeShare(clean)).toBe(1);
		expect(formatUptime(1)).toBe("100");
		expect(formatUptime(28 / 30)).toBe("93.33");
		expect(formatUptime(0.999_96)).toBe("99.99");
		expect(worstState(["operational", "working"])).toBe("working");
		expect(dayStarts(NOW, 3)).toHaveLength(3);
	});

	test("maintenance is upcoming runs, soonest first; history is a week", () => {
		const page = buildStatusPage(SNAPSHOT, NOW);
		expect(page.maintenance.map((item) => item.title)).toEqual([
			"Usage report",
			"Inbox sweep",
		]);
		expect(page.maintenance[0]?.affected).toBeNull();
		expect(page.maintenance[1]?.count).toBe(24);
		expect(page.history).toHaveLength(HISTORY_DAYS);
		expect(page.history[0]?.start).toBeGreaterThan(page.history[1]?.start ?? 0);
	});
});

describe("StatusInterface", () => {
	test("renders the banner, incidents, components and history", () => {
		const html = renderToStaticMarkup(
			<StatusInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={recordingPort([])}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-status"');
		expect(html).toContain("Partial outage");
		expect(html).toContain("Flaky test");
		expect(html).toContain("Dependency audit run failed");
		expect(html).toContain("Docs Crew");
		expect(html).toContain("Degraded performance");
		expect(html).toContain("Scheduled maintenance");
		expect(html).toContain("Past incidents");
		expect(html).toContain("No incidents reported");
		// The strips do not pose as full run history: the basis is stated.
		expect(html).toContain("on the day of their latest run");
		expect(html.match(/data-testid="status-component"/g)).toHaveLength(3);
	});

	test("a calm workspace reads all systems operational with no incident list", () => {
		const html = renderToStaticMarkup(
			<StatusInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={recordingPort([])}
				snapshot={CALM}
				threadView={null}
			/>
		);
		expect(html).toContain("All systems operational");
		expect(html).not.toContain('id="status-incidents-heading"');
		expect(html).toContain("100% uptime");
	});

	test("loading shows a skeleton, not a verdict", () => {
		const html = renderToStaticMarkup(
			<StatusInterface
				activeThreadId={null}
				loading
				params={{}}
				port={recordingPort([])}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("status-banner");
		expect(html).not.toContain("status-empty");
	});

	test("an empty workspace explains itself and can start a thread", async () => {
		const log: string[] = [];
		const view = await mount(<Host log={log} snapshot={EMPTY} />);
		const empty = view.container.querySelector('[data-testid="status-empty"]');
		expect(empty?.textContent).toContain("No agents to report on");
		await click(empty?.querySelector("button"));
		expect(log).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("an incident opens the host's thread view in a panel, and closes", async () => {
		const log: string[] = [];
		const view = await mount(<Host log={log} />);
		const incident = view.container.querySelector<HTMLButtonElement>(
			'[data-thread-id="thread-flaky"]'
		);
		await click(incident);
		expect(log).toEqual(["open:thread-flaky"]);
		const panel = view.container.querySelector(
			'[data-testid="status-thread-panel"]'
		);
		expect(panel?.textContent).toContain("Flaky test");
		expect(panel?.textContent).toContain("Affects Grace");
		expect(
			panel?.querySelector('[data-testid="host-thread-view"]')
		).toBeTruthy();
		expect(document.activeElement?.tagName).toBe("H2");
		expect(
			view.container
				.querySelector('[data-thread-id="thread-flaky"]')
				?.getAttribute("aria-current")
		).toBe("true");

		await click(view.container.querySelector('[aria-label="Close thread"]'));
		expect(log).toEqual(["open:thread-flaky", "close"]);
		expect(
			view.container.querySelector('[data-testid="status-thread-panel"]')
		).toBeNull();
		await view.dispose();
	});

	test("Escape closes the open thread", async () => {
		const log: string[] = [];
		const view = await mount(<Host initialThreadId="thread-notes" log={log} />);
		const root = view.container.querySelector(
			'[data-testid="interface-status"]'
		);
		await act(async () => {
			root?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(log).toEqual(["close"]);
		await view.dispose();
	});

	test("team groups collapse and expand", async () => {
		const view = await mount(<Host log={[]} />);
		const toggle = view.container.querySelector<HTMLButtonElement>(
			'[data-testid="status-group"] button[aria-expanded]'
		);
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		await click(toggle);
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		await click(toggle);
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		await view.dispose();
	});

	test("uptime bars are one tab stop; arrows walk the days with a tooltip", async () => {
		const view = await mount(<Host log={[]} />);
		const strip = view.container.querySelector('ol[aria-label^="Grace"]');
		const bars = [...(strip?.querySelectorAll("button") ?? [])];
		expect(bars).toHaveLength(UPTIME_DAYS);
		expect(bars.filter((bar) => bar.tabIndex === 0)).toHaveLength(1);
		const today = bars.at(-1);
		await act(async () => today?.focus());
		const tooltip = strip?.parentElement?.querySelector('[role="tooltip"]');
		expect(tooltip?.id).toBe(today?.getAttribute("aria-describedby") ?? "");
		const degraded = bars.filter(
			(bar) => bar.getAttribute("data-level") === "degraded"
		);
		expect(degraded).toHaveLength(1);
		await act(async () => {
			today?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
		});
		expect(document.activeElement).toBe(bars.at(-2) ?? null);
		expect(bars.at(-2)?.tabIndex).toBe(0);
		await act(async () => degraded[0]?.focus());
		expect(
			strip?.parentElement?.querySelector('[role="tooltip"]')?.textContent
		).toContain("Flaky test");
		await view.dispose();
	});

	test("New thread starts an empty thread through the port", async () => {
		const log: string[] = [];
		const view = await mount(<Host log={log} />);
		const button = [...view.container.querySelectorAll("button")].find(
			(element) => element.textContent?.trim() === "New thread"
		);
		await click(button);
		expect(log).toEqual(["start:{}"]);
		await view.dispose();
	});
});
