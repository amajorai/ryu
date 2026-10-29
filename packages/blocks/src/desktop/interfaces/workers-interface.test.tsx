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
import { screenLabel, workerPose } from "./workers-diorama.tsx";
import { WorkersInterface } from "./workers-interface.tsx";
import {
	buildWorkers,
	layoutOffice,
	officeColumns,
	threadContext,
	workerIndexForThread,
	workerTotals,
	workspaceName,
} from "./workers-model.ts";
import { deskLabel } from "./workers-status.tsx";

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
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Runs the audits",
			id: "agent-mary",
			name: "Mary",
			status: "idle",
		},
	],
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
			agentIds: ["agent-mary"],
			id: "thread-audit",
			lastMessage: "Two advisories need a patch.",
			runState: "failed",
			title: "Audit lockfile",
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

async function press(key: string) {
	await act(async () => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			(candidate.getAttribute("aria-label") ??
				candidate.textContent?.trim()) === label
	);
}

function desks(container: HTMLElement) {
	return [
		...container.querySelectorAll<HTMLButtonElement>(
			'[data-testid="workers-desk"]'
		),
	];
}

function sheet(container: HTMLElement) {
	return container.querySelector('[data-testid="workers-sheet"]');
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

describe("workers model", () => {
	test("each agent becomes a worker with one pressing state", () => {
		const workers = buildWorkers(SNAPSHOT);
		expect(workers.map((worker) => [worker.name, worker.state])).toEqual([
			["Ada", "your-turn"],
			["Grace", "working"],
			["Linus", "idle"],
			["Mary", "attention"],
		]);
		expect(workers[1]?.current?.id).toBe("thread-triage");
		expect(workers[0]?.current?.id).toBe("thread-notes");
		expect(workers[2]?.current).toBe(undefined);
		// Every count is of workers by their one state, so the buckets partition
		// the fleet: Grace's reply waits too, but she counts once, as working.
		expect(workerTotals(workers)).toEqual({
			waitingOnYou: 2,
			workers: 4,
			working: 1,
		});
		expect(workerIndexForThread(workers, "thread-triage")).toBe(1);
		expect(workerIndexForThread(workers, "missing")).toBe(-1);
	});

	test("thread context names its project and length", () => {
		const [notes] = SNAPSHOT.threads;
		expect(notes && threadContext(notes, SNAPSHOT.groups)).toBe(
			"Website · 2 messages"
		);
	});

	test("a desk says who sits there, their state and their task", () => {
		const [ada, , linus] = buildWorkers(SNAPSHOT);
		expect(ada && deskLabel(ada)).toBe(
			"Ada, Waiting on you, working on Release notes"
		);
		expect(linus && deskLabel(linus)).toBe("Linus, Idle, no tasks yet");
	});

	test("the office seats every worker in rows facing the window wall", () => {
		const team = buildWorkers(SNAPSHOT);
		const plan = layoutOffice(team);
		expect(plan.desks.map((desk) => desk.worker.id)).toEqual(
			team.map((worker) => worker.id)
		);
		expect(plan.columns).toBe(2);
		expect(plan.rows).toBe(2);
		// Every desk is inside the room, clear of the coffee corner.
		for (const desk of plan.desks) {
			expect(Math.abs(desk.x)).toBeLessThan(plan.halfWidth - 0.7);
			expect(Math.abs(desk.z)).toBeLessThan(plan.halfDepth - 0.4);
			expect(desk.x).toBeLessThan(plan.coffee.x - 1);
		}
		// Desks never share a footprint.
		for (const [index, desk] of plan.desks.entries()) {
			for (const other of plan.desks.slice(index + 1)) {
				expect(Math.hypot(desk.x - other.x, desk.z - other.z)).toBeGreaterThan(
					2
				);
			}
		}
	});

	test("rows grow with the team and a short last row is centred", () => {
		expect([1, 3, 4, 6, 8, 9, 14].map(officeColumns)).toEqual([
			1, 3, 2, 3, 4, 4, 5,
		]);
		const five = layoutOffice(
			buildWorkers({
				...SNAPSHOT,
				agents: ["a", "b", "c", "d", "e"].map((id) => ({
					avatarUrl: null,
					description: "",
					id,
					name: id,
					status: "idle" as const,
				})),
			})
		);
		const lastRow = five.desks.slice(3).map((desk) => desk.x);
		const firstRow = five.desks.slice(0, 3).map((desk) => desk.x);
		const middle = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(middle(lastRow)).toBeCloseTo(middle(firstRow), 5);
		expect(layoutOffice([]).desks).toEqual([]);
	});

	test("a worker's pose and screen plate follow its state", () => {
		expect(workerPose("working")).toBe("working");
		expect(workerPose("your-turn")).toBe("needs-you");
		expect(workerPose("attention")).toBe("failed");
		expect(workerPose("idle")).toBe("idle");
		const [ada] = buildWorkers(SNAPSHOT);
		expect(ada && screenLabel(ada)).toBe(
			"Ada's screen: Release notes, Waiting on you. Open the task"
		);
	});

	test("the workspace is named after a group only when every worker is in it", () => {
		const everyone = SNAPSHOT.agents.map((agent) => agent.id);
		// Website holds Ada alone; it must not title Grace, Linus and Mary.
		expect(workspaceName(SNAPSHOT.groups, everyone)).toBe("Workers");
		expect(workspaceName(SNAPSHOT.groups, ["agent-ada"])).toBe("Website");
		const crew = {
			id: "team",
			kind: "team" as const,
			memberAgentIds: everyone,
			name: "Crew",
		};
		expect(workspaceName([crew, ...SNAPSHOT.groups], everyone)).toBe("Crew");
		expect(
			workspaceName(
				[{ ...crew, memberAgentIds: ["agent-ada"] }, ...SNAPSHOT.groups],
				everyone
			)
		).toBe("Workers");
		expect(workspaceName([], everyone)).toBe("Workers");
	});
});

function workers(
	overrides: Partial<Parameters<typeof WorkersInterface>[0]> = {}
) {
	return (
		<WorkersInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={recordingPort().port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("WorkersInterface", () => {
	test("renders a desk per worker whose screen shows its current task", () => {
		const markup = renderToStaticMarkup(workers());
		expect(markup).toContain('data-testid="interface-workers"');
		expect(markup.match(/data-testid="workers-desk"/g)).toHaveLength(4);
		expect(markup.match(/data-testid="workers-screen"/g)).toHaveLength(3);
		// The screens show the real conversation and its state.
		expect(markup).toContain("Crash triage");
		expect(markup).toContain("Needs attention");
		expect(markup).toContain("No tasks yet");
		// The HUD: the workspace's name, New task and the counters. Website
		// holds only Ada, so it does not title the whole office.
		expect(markup).toContain('leading-7">Workers</p>');
		expect(markup).toContain('aria-label="New task"');
		expect(markup).toContain('aria-label="Worker counters"');
		expect(markup).toContain("waiting on you");
	});

	test("renders loading and empty states", () => {
		const loading = renderToStaticMarkup(workers({ loading: true }));
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).not.toContain('data-testid="workers-desk"');

		const empty = renderToStaticMarkup(
			workers({ snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		expect(empty).toContain("No workers yet");
		expect(empty).not.toContain('data-testid="workers-desk"');
	});

	test("a screen opens its task; a worker opens their desk", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(workers({ port }));
		const [ada, , linus] = desks(view.container);
		await click(view.container.querySelector('[data-testid="workers-screen"]'));
		expect(calls).toEqual(["open:thread-notes"]);
		await click(ada);
		expect(sheet(view.container)?.textContent).toContain("Ada");
		await click(linus);
		expect(sheet(view.container)?.textContent).toContain("Linus");
		expect(sheet(view.container)?.textContent).toContain("No tasks yet");
		await view.dispose();
	});

	test("a host page over the workers keeps its keys", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			workers({
				activeThreadId: "thread-triage",
				port,
				threadView: <div>Host chat</div>,
			})
		);
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the workers they are inert: <body> keys pass by.
		view.container.setAttribute("inert", "");
		await press("Escape");
		expect(sheet(view.container)).not.toBe(null);
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press("Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("a worker's desk starts a task only with what the user typed", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(workers({ port }));
		await click(desks(view.container)[2]);
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Review the README  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					key: "Enter",
				})
			);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-linus","prompt":"Review the README"}',
		]);
		await view.dispose();
	});

	test("an open task shows the host view; Back goes to its worker", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			workers({
				activeThreadId: "thread-audit",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = sheet(view.container);
		expect(panel?.textContent).toContain("Host chat");
		expect(panel?.textContent).toContain("Audit lockfile");
		expect(panel?.textContent).toContain("Mary's computer");
		expect(
			desks(view.container)
				.find((desk) => desk.dataset.workerId === "agent-mary")
				?.getAttribute("aria-current")
		).toBe("true");
		await click(button(view.container, "Back to Mary"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("Close and Escape shut the sheet", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			workers({
				activeThreadId: "thread-triage",
				port,
				threadView: <div>Host chat</div>,
			})
		);
		await click(button(view.container, "Close task"));
		expect(calls).toEqual(["close"]);
		await view.dispose();

		const plain = await mount(workers());
		await click(button(plain.container, "New task"));
		expect(sheet(plain.container)).not.toBe(null);
		await press("Escape");
		expect(sheet(plain.container)).toBe(null);
		await plain.dispose();
	});
});
