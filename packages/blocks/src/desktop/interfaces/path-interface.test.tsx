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
import { usefulStateFixture } from "./game-acts-fixture.ts";
import { PathInterface } from "./path-interface.tsx";
import {
	buildPath,
	pathCurrentThread,
	pathLeaderboard,
	pathStats,
	pathStreak,
	pathSwing,
	pathUnitItemCount,
	repliedToday,
} from "./path-model.ts";
import { layoutPathWorld, trailColumns } from "./path-world.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Midday local time keeps "today" and "yesterday" stable in any time zone.
const NOW = new Date(2026, 9, 12, 12, 0, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

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
		updatedAt: ago(HOUR),
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
			messageCount: 6,
			runState: "completed",
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30 * MINUTE),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessageRole: "user",
			messageCount: 3,
			title: "Intro edits",
			updatedAt: ago(90 * MINUTE),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			messageCount: 9,
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5 * MINUTE),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			messageCount: 4,
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(2 * HOUR),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-old",
			messageCount: 1,
			runState: "completed",
			teamId: "team-docs",
			title: "Style guide",
			updatedAt: ago(DAY),
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			messageCount: 1,
			title: "Loose ends",
			updatedAt: ago(3 * DAY),
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

function buttonStartingWith(container: HTMLElement, prefix: string) {
	return [...container.querySelectorAll("button")].find((candidate) =>
		candidate.getAttribute("aria-label")?.startsWith(prefix)
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

describe("path model", () => {
	test("units run projects, then teams, then each agent, then no agent", () => {
		const { units } = buildPath(SNAPSHOT, NOW.getTime());
		expect(units.map((unit) => [unit.kind, unit.title])).toEqual([
			["project", "Site"],
			["team", "Docs Crew"],
			["agent", "Ada"],
			["agent", "Grace"],
			["unfiled", "Without an agent"],
		]);
		expect(units.map((unit) => unit.index)).toEqual([1, 2, 3, 4, 5]);
		expect(units.map((unit) => unit.tone)).toEqual([
			"primary",
			"warning",
			"berry",
			"teal",
			"primary",
		]);
		expect(units[2]?.description).toBe("Writes the release notes");
		// Groups have no description: their goal line summarizes the unit.
		expect(units[0]?.description).toBe("1 thread · 1 running");
		expect(units[1]?.description).toBe("2 threads · 1 needs you");
		expect(units[4]?.description).toBe("Threads with no agent yet");
		expect(units.map((unit) => unit.start)).toEqual([
			{ projectId: "project-site" },
			{ teamId: "team-docs" },
			{ agentId: "agent-ada" },
			{ agentId: "agent-grace" },
			{},
		]);
	});

	test("the current stop is the newest failed run, else the newest reply", () => {
		expect(pathCurrentThread(SNAPSHOT.threads, NOW.getTime())?.id).toBe(
			"thread-flaky"
		);
		const calm = SNAPSHOT.threads.filter((item) => item.id !== "thread-flaky");
		expect(pathCurrentThread(calm, NOW.getTime())?.id).toBe("thread-notes");
		expect(
			pathCurrentThread(
				calm.filter((item) => item.lastMessageRole !== "assistant"),
				NOW.getTime()
			)
		).toBeUndefined();
	});

	test("stops read as done, current, reply, working, or waiting, finished first", () => {
		const { currentThreadId, units } = buildPath(SNAPSHOT, NOW.getTime());
		expect(currentThreadId).toBe("thread-flaky");
		const states = (index: number) =>
			units[index]?.stops.map((stop) => [stop.thread.id, stop.state]);
		expect(states(0)).toEqual([["thread-triage", "working"]]);
		expect(states(1)).toEqual([
			["thread-old", "done"],
			["thread-notes", "reply"],
		]);
		expect(states(2)).toEqual([["thread-intro", "waiting"]]);
		expect(states(3)).toEqual([["thread-flaky", "current"]]);
		expect(units[1]?.doneCount).toBe(1);
	});

	test("units with two or more stops and a finished one end in a milestone", () => {
		const short = buildPath(SNAPSHOT, NOW.getTime());
		// Docs Crew holds two stops, one done; the rest hold one each.
		expect(short.units.map((unit) => unit.milestone)).toEqual([
			null,
			"chest",
			null,
			null,
			null,
		]);
		expect(short.stopCount).toBe(SNAPSHOT.threads.length);
		const longer: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				...SNAPSHOT.threads,
				thread({
					agentIds: ["agent-ada"],
					id: "thread-glossary",
					runState: "completed",
					teamId: "team-docs",
					title: "Glossary",
					updatedAt: ago(2 * DAY),
				}),
			],
		};
		const { units } = buildPath(longer, NOW.getTime());
		expect(units[1]?.milestone).toBe("chest");
		expect(units[1]?.doneCount).toBe(2);
		// A day later the unanswered reply counts as closed out.
		const later = buildPath(longer, NOW.getTime() + 24 * HOUR);
		expect(later.units[1]?.milestone).toBe("trophy");
		expect(later.units[1]?.doneCount).toBe(3);
		expect(later.units[1]?.description).toBe("3 threads · all done");
	});

	test("a stale reply is done only when the agent's run finished", () => {
		const team = (threads: InterfaceThread[]): InterfaceSnapshot => ({
			...SNAPSHOT,
			groups: SNAPSHOT.groups.filter((group) => group.id === "team-docs"),
			threads,
		});
		const docs = (
			input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
		) => thread({ agentIds: ["agent-ada"], teamId: "team-docs", ...input });
		const stateOf = (model: ReturnType<typeof buildPath>, id: string) =>
			model.units[0]?.stops.find((stop) => stop.thread.id === id)?.state;
		// The agent asked a question 30h and 26h ago; neither run is known to
		// have finished, so both still need you however old they are.
		const asked = buildPath(
			team([
				docs({ id: "thread-a", updatedAt: ago(30 * HOUR) }),
				docs({ id: "thread-b", updatedAt: ago(26 * HOUR) }),
			]),
			NOW.getTime()
		);
		expect(asked.currentThreadId).toBe("thread-b");
		expect(stateOf(asked, "thread-a")).toBe("reply");
		expect(asked.doneCount).toBe(0);
		expect(asked.units[0]?.milestone).toBeNull();
		expect(asked.units[0]?.description).toBe("2 threads · 2 need you");
		// Pinned, epoch-fallback, and unparseable timestamps never close out.
		const kept = buildPath(
			team([
				docs({
					id: "thread-pinned",
					pinned: true,
					runState: "completed",
					updatedAt: ago(3 * DAY),
				}),
				docs({
					id: "thread-epoch",
					runState: "completed",
					updatedAt: new Date(0).toISOString(),
				}),
				docs({ id: "thread-bad", runState: "completed", updatedAt: "nope" }),
				docs({ id: "thread-failed", runState: "failed", updatedAt: ago(HOUR) }),
			]),
			NOW.getTime()
		);
		expect(kept.currentThreadId).toBe("thread-failed");
		for (const id of ["thread-pinned", "thread-epoch", "thread-bad"]) {
			expect(stateOf(kept, id)).toBe("reply");
		}
		expect(kept.doneCount).toBe(0);
		// A finished run left a day is done, and never comes back as current
		// once the newer reply is answered.
		const finished = team([
			docs({
				id: "thread-a",
				runState: "completed",
				updatedAt: ago(30 * HOUR),
			}),
			docs({ id: "thread-b", runState: "completed", updatedAt: ago(2 * HOUR) }),
		]);
		const before = buildPath(finished, NOW.getTime());
		expect(before.currentThreadId).toBe("thread-b");
		expect(stateOf(before, "thread-a")).toBe("done");
		const answered = buildPath(
			team([
				finished.threads[0] as InterfaceThread,
				{
					...(finished.threads[1] as InterfaceThread),
					lastMessageRole: "user",
				},
			]),
			NOW.getTime()
		);
		expect(answered.currentThreadId).toBeNull();
		expect(stateOf(answered, "thread-a")).toBe("done");
		expect(answered.doneCount).toBe(1);
		expect(answered.units[0]?.milestone).toBe("chest");
	});

	test("an empty group still gets a unit, with no milestone", () => {
		const snapshot: InterfaceSnapshot = { ...SNAPSHOT, threads: [] };
		const { units } = buildPath(snapshot);
		expect(units.map((unit) => unit.title)).toEqual(["Site", "Docs Crew"]);
		expect(units[0]?.milestone).toBeNull();
		expect(units[0]?.description).toBe("No threads yet");
	});

	test("the path winds both ways on one phase across units", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(pathSwing)).toEqual([
			0, -1, -1.6, -1, 0, 1, 1.6, 1, 0,
		]);
		const { units } = buildPath(SNAPSHOT, NOW.getTime());
		// Stops, the milestone, and the `+` each take one place on the path.
		expect(units.map(pathUnitItemCount)).toEqual([2, 4, 2, 2, 2]);
	});

	test("the streak counts outcomes; XP and the daily goal come from activity", () => {
		// Today's finished answer and yesterday's: the failed run, the live run
		// and the user-last threads are no outcome.
		expect(pathStreak(SNAPSHOT.threads, NOW)).toBe(2);
		// Nothing today yet: yesterday's streak still stands.
		const tomorrow = new Date(NOW.getTime() + DAY);
		expect(pathStreak(SNAPSHOT.threads, tomorrow)).toBe(2);
		expect(
			pathStreak(SNAPSHOT.threads, new Date(NOW.getTime() + 2 * DAY))
		).toBe(0);
		// A user's last word today and a live run today both count.
		expect(repliedToday(SNAPSHOT.threads, NOW)).toBe(2);
		const stats = pathStats(SNAPSHOT, NOW);
		expect(stats.xp).toBe(24);
		expect(stats.week).toHaveLength(7);
		expect(stats.week.at(-1)?.today).toBe(true);
		expect(stats.week.map((day) => day.active)).toEqual([
			false,
			false,
			false,
			false,
			false,
			true,
			true,
		]);
		// An outcome counts on the day its turn finished, not the last update.
		const late = thread({
			id: "thread-late",
			outcome: {
				finishedAt: ago(2 * DAY),
				headline: "Edited 2 files",
				source: "messages",
			},
			updatedAt: ago(30 * MINUTE),
		});
		expect(pathStreak([late], NOW)).toBe(0);
		expect(pathStreak([late, ...SNAPSHOT.threads], NOW)).toBe(3);
		// Messages alone (the agent still running, or the user's word last) are no outcome.
		expect(
			pathStreak(
				[thread({ id: "live", running: true, updatedAt: ago(MINUTE) })],
				NOW
			)
		).toBe(0);
	});

	test("the leaderboard ranks agents by messages", () => {
		expect(
			pathLeaderboard(SNAPSHOT).map((row) => [row.agent.name, row.xp, row.rank])
		).toEqual([
			["Grace", 13, 1],
			["Ada", 10, 2],
			["Linus", 0, 3],
		]);
	});
});

function render(overrides: Partial<Parameters<typeof PathInterface>[0]> = {}) {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<PathInterface
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

describe("path world", () => {
	test("the streak and goal setting: on by default, off when set, live from Settings", async () => {
		expect(render()).toContain("Day streak");
		expect(render({ params: { stats: false } })).not.toContain("Day streak");
		const { port } = recordingPort();
		const shell = (stats?: boolean) => (
			<PathInterface
				activeThreadId={null}
				loading={false}
				params={stats === undefined ? {} : { stats }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const view = await mount(shell());
		expect(view.container.textContent).toContain("Day streak");
		await view.rerender(shell(false));
		expect(view.container.textContent).not.toContain("Day streak");
		await view.dispose();
	});

	test("lays a stone per stop on a switchback trail, a sign per unit", () => {
		const model = buildPath(SNAPSHOT);
		const world = layoutPathWorld(model);
		expect(world.stones).toHaveLength(model.stopCount);
		expect(world.signs.map((sign) => sign.unit.id)).toEqual(
			model.units.map((unit) => unit.id)
		);
		// The trail ends at the goal flag.
		expect(world.trail.at(-1)).toEqual(world.finish);
		// A signpost never stands on a stone.
		for (const sign of world.signs) {
			for (const stone of world.stones) {
				expect(
					Math.hypot(sign.at[0] - stone.at[0], sign.at[1] - stone.at[1])
				).toBeGreaterThan(1.2);
			}
		}
		// Stones never crowd each other, and all sit inside the bounds.
		for (const [index, stone] of world.stones.entries()) {
			const [x, z] = stone.at;
			expect(x).toBeGreaterThan(world.bounds.minX);
			expect(x).toBeLessThan(world.bounds.maxX);
			expect(z).toBeGreaterThan(world.bounds.minZ);
			expect(z).toBeLessThan(world.bounds.maxZ);
			for (const other of world.stones.slice(index + 1)) {
				expect(Math.hypot(other.at[0] - x, other.at[1] - z)).toBeGreaterThan(
					1.2
				);
			}
		}
	});

	test("the trail climbs: each stone stands no lower than the one before", () => {
		const world = layoutPathWorld(buildPath(SNAPSHOT));
		for (const [index, stone] of world.stones.entries()) {
			const before = world.stones[index - 1];
			if (before) {
				expect(stone.y).toBeGreaterThanOrEqual(before.y);
			}
		}
		const top = Math.max(...world.stones.map((stone) => stone.y));
		expect(world.finishY).toBeGreaterThanOrEqual(top);
		expect(world.terraces.length).toBeGreaterThan(0);
		// Every climb onto a terrace has its stairs.
		expect(world.stairs.length).toBeGreaterThanOrEqual(world.terraces.length);
	});

	test("the mascot stands on the stone the path points at", () => {
		const model = buildPath(SNAPSHOT);
		const world = layoutPathWorld(model);
		expect(world.mascot?.stone.stop.thread.id ?? null).toBe(
			model.currentThreadId
		);
		expect(world.mascot?.at).toEqual(world.mascot?.stone.at);
		expect(trailColumns(1)).toBe(3);
		expect(trailColumns(40)).toBe(6);
	});
});

describe("PathInterface", () => {
	test("renders loading and empty states", () => {
		const loadingMarkup = render({ loading: true });
		expect(loadingMarkup).toContain('data-testid="interface-path"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).not.toContain("Crash triage");

		const emptyMarkup = render({
			snapshot: { ...SNAPSHOT, groups: [], threads: [] },
		});
		expect(emptyMarkup).toContain("No conversations yet");
		expect(emptyMarkup).toContain("New thread");
	});

	test("an empty path with unowned asks keeps its guidance and its ask queue", () => {
		const markup = render({
			snapshot: {
				...SNAPSHOT,
				agents: [],
				asks: usefulStateFixture().asks,
				groups: [],
				threads: [],
			},
		});
		expect(markup).toContain("No conversations yet");
		expect(markup).toContain("data-queue-button");
		expect(markup).toContain('data-ask-queue="reveal"');
		expect(markup).toMatch(/\d need you/);
		const quiet = render({
			snapshot: { ...SNAPSHOT, agents: [], asks: [], groups: [], threads: [] },
		});
		expect(quiet).not.toContain("data-queue-button");
	});

	test("renders units, stops, the callout, milestones, and the HUD counters", () => {
		const markup = render();
		expect(markup).toContain("Unit 1 · Project");
		expect(markup).toContain("Docs Crew");
		expect(markup).toContain("Review");
		expect(markup).toContain('aria-label="Review: Flaky test. Run failed');
		expect(markup).toMatch(
			/Unit 2 (milestone: 1 of 2|complete: all 2) finished/
		);
		expect(markup).toMatch(/End of the path: \d of 6 finished/);
		// The compact bar's stats open the rail cards as popovers.
		expect(markup).toContain('aria-label="24 XP. Show leaderboard"');
		expect(markup).toContain("Daily goal: ");
		expect(markup).toContain('aria-label="Your progress"');
		expect(markup).not.toContain('data-testid="path-thread-panel"');
	});

	test("clicking a stop opens it; a unit's plus starts a thread there", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PathInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(buttonStartingWith(view.container, "Crash triage."));
		await click(buttonStartingWith(view.container, "New thread in Site"));
		await click(
			buttonStartingWith(view.container, "New thread with Docs Crew")
		);
		await click(buttonStartingWith(view.container, "New thread with Ada"));
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"projectId":"project-site"}',
			'start:{"teamId":"team-docs"}',
			'start:{"agentId":"agent-ada"}',
		]);
		await view.dispose();
	});

	test("shows the host's thread view in a panel and closes it", async () => {
		const { calls, port } = recordingPort();
		function Host() {
			const [open, setOpen] = useState<string | null>("thread-notes");
			const hostPort: InterfacePort = {
				...port,
				closeThread: () => {
					port.closeThread();
					setOpen(null);
				},
			};
			const view: ReactNode = open ? (
				<div data-testid="host-thread">{open}</div>
			) : null;
			return (
				<PathInterface
					activeThreadId={open}
					loading={false}
					params={{}}
					port={hostPort}
					snapshot={SNAPSHOT}
					threadView={view}
				/>
			);
		}
		const view = await mount(<Host />);
		const panel = view.container.querySelector(
			'[data-testid="path-thread-panel"]'
		);
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Release notes");
		expect(panel?.textContent).toContain("Unit 2 · Docs Crew");
		expect(
			view.container.querySelector('[data-testid="host-thread"]')?.textContent
		).toBe("thread-notes");
		expect(
			view.container
				.querySelector('[data-thread-id="thread-notes"]')
				?.getAttribute("aria-current")
		).toBe("true");
		await click(view.container.querySelector('[aria-label="Close thread"]'));
		expect(calls).toEqual(["close"]);
		expect(
			view.container.querySelector('[data-testid="path-thread-panel"]')
		).toBeNull();
		await view.dispose();
	});

	test("arrow keys walk the path from stop to stop", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PathInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const first = buttonStartingWith(view.container, "Crash triage.");
		await act(async () => {
			first?.focus();
		});
		await act(async () => {
			first?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
			);
		});
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"New thread in Site"
		);
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Home" })
			);
		});
		expect(document.activeElement).toBe(first ?? null);
		await view.dispose();
	});
});
