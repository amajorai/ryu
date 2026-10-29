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
import { LobbyInterface } from "./lobby-interface.tsx";
import {
	addToSquad,
	buildMembers,
	dailyQuests,
	defaultSquadIds,
	lobbyLevel,
	milestoneQuests,
	newsItems,
	nextMilestone,
	playMode,
	resolveSquad,
	SQUAD_SIZE,
	weeklyQuests,
} from "./lobby-model.ts";
import {
	layoutLobbyWorld,
	PLAZA_RADIUS,
	PODIUM_RADIUS,
	RECENT_MATCHES,
} from "./lobby-world.ts";

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

function agent(id: string, name: string, status: "idle" | "working" = "idle") {
	return { avatarUrl: null, description: `${name} agent`, id, name, status };
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		agent("agent-ada", "Ada"),
		agent("agent-grace", "Grace", "working"),
		agent("agent-linus", "Linus"),
		agent("agent-mae", "Mae"),
		agent("agent-zed", "Zed"),
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
		{
			id: "project-empty",
			kind: "project",
			memberAgentIds: [],
			name: "Empty Project",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 12,
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 6,
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			projectId: "project-site",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-mae"],
			id: "thread-mae",
			lastMessage: "Done.",
			messageCount: 30,
			title: "Mae's report",
			updatedAt: ago(200),
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

async function press(target: Element | null | undefined, key: string) {
	if (!target) {
		throw new Error("Expected a key target");
	}
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
		// React falls back to key events for change detection under happy-dom.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll<HTMLElement>("[aria-label]")].find(
		(element) => element.getAttribute("aria-label") === label
	);
}

function tab(container: HTMLElement, name: string) {
	return [...container.querySelectorAll<HTMLElement>("[role='tab']")].find(
		(element) => element.textContent?.startsWith(name)
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

function lobby(
	port: InterfacePort,
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		params: Parameters<typeof LobbyInterface>[0]["params"];
		snapshot: InterfaceSnapshot;
		threadView: ReactElement | null;
	}> = {}
) {
	return (
		<LobbyInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={overrides.params ?? {}}
			port={port}
			snapshot={overrides.snapshot ?? SNAPSHOT}
			threadView={overrides.threadView ?? null}
		/>
	);
}

describe("lobby model", () => {
	test("levels come from messages: 100 XP each, a level every 1,000", () => {
		expect(lobbyLevel(0)).toEqual({
			level: 1,
			progress: 0,
			span: 1000,
			totalXp: 0,
		});
		expect(lobbyLevel(74)).toMatchObject({
			level: 8,
			progress: 400,
			totalXp: 7400,
		});
	});

	test("squad states follow each agent's threads", () => {
		const members = buildMembers(SNAPSHOT);
		const state = (id: string) =>
			members.find((member) => member.agent.id === id)?.state;
		expect(state("agent-grace")).toBe("in-match");
		expect(state("agent-ada")).toBe("needs-you");
		expect(state("agent-mae")).toBe("needs-you");
		expect(state("agent-linus")).toBe("ready");
		expect(state("agent-zed")).toBe("ready");

		const idle = buildMembers({
			...SNAPSHOT,
			agents: SNAPSHOT.agents.map((entry) => ({ ...entry, status: "idle" })),
			threads: SNAPSHOT.threads.map((entry) => ({ ...entry, running: false })),
		});
		const grace = idle.find((member) => member.agent.id === "agent-grace");
		expect(grace?.state).toBe("downed");
		expect(grace?.focus?.id).toBe("thread-flaky");
	});

	test("the default squad is the four most recently active agents", () => {
		const members = buildMembers(SNAPSHOT);
		expect(defaultSquadIds(members)).toEqual([
			"agent-grace",
			"agent-ada",
			"agent-linus",
			"agent-mae",
		]);
		const squad = resolveSquad(members, ["agent-zed", "agent-missing"]);
		expect(squad.map((member) => member.agent.id)).toEqual([
			"agent-zed",
			"agent-grace",
			"agent-ada",
			"agent-linus",
		]);
	});

	test("adding to a full squad replaces the last spot only", () => {
		expect(addToSquad(["a", "b", "c", "d"], "e")).toEqual(["a", "b", "c", "e"]);
		expect(addToSquad(["a", "b", "c", "d"], "b")).toEqual(["a", "b", "c", "d"]);
		expect(addToSquad(["a"], "b")).toEqual(["a", "b"]);
	});

	test("dailies: failures first, then replies; live and queued are in progress", () => {
		const quests = dailyQuests(SNAPSHOT);
		expect(quests.map((quest) => quest.id)).toEqual([
			"daily-thread-flaky",
			"daily-thread-notes",
			"daily-thread-mae",
			"daily-thread-triage",
			"daily-thread-question",
		]);
		expect(quests.map((quest) => quest.complete)).toEqual([
			true,
			true,
			true,
			false,
			false,
		]);
		expect(quests[0]?.detail).toBe("Check the failed run · Grace");
		expect(quests[1]?.detail).toBe("Reply to Ada");
		expect(quests[1]?.xp).toBe(1200);
	});

	test("weeklies count finished threads per team and project", () => {
		const quests = weeklyQuests(SNAPSHOT);
		expect(
			quests.map((quest) => [quest.title, quest.progress, quest.goal])
		).toEqual([
			["Docs Crew", 1, 1],
			["Empty Project", 0, 1],
			["Site", 0, 2],
		]);
		expect(quests[0]?.complete).toBe(true);
		expect(quests[0]?.action).toEqual({
			kind: "open",
			threadId: "thread-notes",
		});
		expect(quests[1]?.action).toEqual({
			kind: "start",
			projectId: "project-empty",
		});
		// An unfinished quest opens the first thread that is not finished.
		expect(quests[2]?.action).toEqual({
			kind: "open",
			threadId: "thread-triage",
		});
	});

	test("milestones count messages toward the next tier", () => {
		expect(nextMilestone(0)).toEqual({ goal: 10, tier: 1 });
		expect(nextMilestone(30)).toEqual({ goal: 50, tier: 3 });
		expect(nextMilestone(999)).toEqual({ goal: 250, tier: 5 });
		const quests = milestoneQuests(buildMembers(SNAPSHOT));
		expect(quests[0]).toMatchObject({
			goal: 50,
			id: "milestone-agent-mae",
			progress: 30,
		});
		expect(quests[0]?.title).toBe("Talk shop with Mae");
		expect(quests[0]?.detail).toBe("Tier 3 of 5");
		expect(quests[0]?.metric).toBe("30 / 50 messages");
		const zed = quests.find((quest) => quest.agentId === "agent-zed");
		expect(zed?.action).toEqual({ agentId: "agent-zed", kind: "start" });
	});

	test("the play mode follows the member's latest team or project", () => {
		const members = buildMembers(SNAPSHOT);
		const mode = (id: string) =>
			playMode(
				members.find((member) => member.agent.id === id),
				SNAPSHOT.groups
			);
		expect(mode("agent-ada")).toEqual({
			label: "Docs Crew",
			teamId: "team-docs",
		});
		expect(mode("agent-zed")).toEqual({ label: "Solo" });
		expect(playMode(undefined, SNAPSHOT.groups)).toEqual({ label: "Solo" });
	});

	test("news is the most recent threads", () => {
		const items = newsItems(SNAPSHOT, 3);
		expect(items.map((item) => item.thread.id)).toEqual([
			"thread-triage",
			"thread-notes",
			"thread-question",
		]);
		expect(items[0]?.agent?.name).toBe("Grace");
	});
});

describe("lobby world", () => {
	const members = buildMembers(SNAPSHOT);
	const squad = resolveSquad(members, null);

	test("every squad place stands on the podium, a step apart", () => {
		const world = layoutLobbyWorld(squad);
		expect(world.spots).toHaveLength(SQUAD_SIZE);
		for (const spot of world.spots) {
			expect(Math.hypot(...spot.at)).toBeLessThan(PODIUM_RADIUS - 0.4);
		}
		for (const [index, spot] of world.spots.entries()) {
			const next = world.spots[index + 1];
			if (next) {
				expect(
					Math.hypot(next.at[0] - spot.at[0], next.at[1] - spot.at[1])
				).toBeGreaterThan(1.2);
			}
		}
		expect(world.spots.map((spot) => spot.member?.agent.id ?? null)).toEqual(
			squad.map((member) => member.agent.id)
		);
	});

	test("open places are left for a short squad", () => {
		const world = layoutLobbyWorld(squad.slice(0, 2));
		expect(world.spots.filter((spot) => spot.member === null)).toHaveLength(2);
	});

	test("the boards and the portal stand on the plaza, off the podium", () => {
		const world = layoutLobbyWorld(squad);
		for (const at of [world.questBoard, world.portal, world.matches.at]) {
			const radius = Math.hypot(...at);
			expect(radius).toBeGreaterThan(PODIUM_RADIUS + 1);
			expect(radius).toBeLessThan(PLAZA_RADIUS);
		}
		expect(world.matches.threads.length).toBeLessThanOrEqual(RECENT_MATCHES);
		const times = world.matches.threads.map((item) =>
			Date.parse(item.updatedAt)
		);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});
});

describe("lobby interface", () => {
	test("renders the menu, level, and squad on the server", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(lobby(port));
		expect(html).toContain('data-testid="interface-lobby"');
		expect(html).toContain('role="tablist"');
		for (const label of ["Lobby", "Quests", "Squad", "News"]) {
			expect(html).toContain(`>${label}<`);
		}
		expect(html).toContain('aria-label="Level 6, 200 / 1,000 XP to level 7"');
		expect(html).toContain('role="radiogroup"');
		expect(html).toContain("Grace, working, level 1");
		expect(html).toContain('aria-label="Play with Grace"');
		expect(html).not.toContain("Zed, ");
		// The tracker folds into one row: the dailies ready, and the squad.
		expect(html).toContain(
			'aria-label="Daily quests, 3 ready to claim. Open the quest board."'
		);
		expect(html).toContain('aria-label="Squad 4 of 4. Edit squad."');
	});

	test("without WebGL the plaza is a plain list of the squad and matches", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(lobby(port));
		const squad = html.slice(html.indexOf('role="radiogroup"'));
		expect(squad).toContain('data-agent-id="agent-grace"');
		expect(html).toContain("recent matches");
		expect(html).not.toContain("<canvas");
	});

	test("arrows move the squad selection and PLAY sends the typed brief", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(lobby(port));
		const radios = view.container.querySelectorAll("[role='radio']");
		expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
		await press(radios[0], "ArrowRight");
		expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(radios[1] ?? null);

		// PLAY starts a plain thread with the selected member, never scoped to
		// a team or project the user did not pick.
		expect(
			view.container.querySelector("[data-testid='lobby-mode']")?.textContent
		).toBe("Solo · new thread with Ada");
		await click(byLabel(view.container, "Play with Ada"));
		const drop = byLabel(view.container, "Drop in: send the brief to Ada");
		expect(drop?.hasAttribute("disabled")).toBe(true);
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the brief field");
		}
		expect(document.activeElement).toBe(field);
		await typeInto(field, "  Tighten the intro  ");
		expect(
			byLabel(view.container, "Drop in: send the brief to Ada")?.hasAttribute(
				"disabled"
			)
		).toBe(false);
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Tighten the intro" })}`,
		]);
		expect(byLabel(view.container, "Play with Ada")).toBeDefined();
		await view.dispose();
	});

	test("Escape cancels the brief without sending", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(lobby(port));
		await click(byLabel(view.container, "Play with Grace"));
		const field = view.container.querySelector("textarea");
		await typeInto(field as HTMLTextAreaElement, "Never mind");
		await press(field, "Escape");
		expect(calls).toEqual([]);
		expect(byLabel(view.container, "Play with Grace")).toBeDefined();
		await view.dispose();
	});

	test("recent matches open the conversation", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(lobby(port));
		await click(
			view.container.querySelector("button[data-thread-id='thread-triage']")
		);
		expect(calls).toEqual(["open:thread-triage"]);
		await view.dispose();
	});

	test("tabs switch with arrows, and quests claim by opening the thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(lobby(port));
		const lobbyTab = tab(view.container, "Lobby");
		await press(lobbyTab, "ArrowRight");
		const questsTab = tab(view.container, "Quests");
		expect(questsTab?.getAttribute("aria-selected")).toBe("true");
		expect(questsTab?.textContent).toContain("4 ready to claim");

		await click(
			byLabel(view.container, "Claim: Flaky test, open the conversation")
		);
		expect(calls).toEqual(["open:thread-flaky"]);
		// Daily quests carry their state in the status line and CLAIM, not a bar.
		expect(
			view.container.querySelectorAll("#lobby-quest-list [role='progressbar']")
				.length
		).toBe(0);

		await click(view.container.querySelector("#lobby-quests-tab-weekly"));
		expect(
			view.container.querySelectorAll("#lobby-quest-list [role='progressbar']")
				.length
		).toBeGreaterThan(0);
		await click(
			byLabel(view.container, "Start: Empty Project, start a thread")
		);
		expect(calls.at(-1)).toBe(
			`start:${JSON.stringify({ projectId: "project-empty" })}`
		);
		await view.dispose();
	});

	test("picking from the roster puts the agent in the squad and leads with it", async () => {
		const { port } = recordingPort();
		const view = await mount(lobby(port));
		await click(tab(view.container, "Squad"));
		const zed = view.container.querySelector(
			"button[data-agent-id='agent-zed']"
		);
		expect(zed?.getAttribute("aria-label")).toContain("not in squad");
		await click(zed);
		expect(tab(view.container, "Lobby")?.getAttribute("aria-selected")).toBe(
			"true"
		);
		const selected = view.container.querySelector(
			"[role='radio'][aria-checked='true']"
		);
		expect(selected?.getAttribute("data-agent-id")).toBe("agent-zed");
		expect(view.container.querySelectorAll("[role='radio']")).toHaveLength(4);
		expect(byLabel(view.container, "Play with Zed")).toBeDefined();
		await view.dispose();
	});

	test("news pages through stories and reads one", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(lobby(port));
		await click(tab(view.container, "News"));
		expect(view.container.textContent).toContain("Crash triage");
		await click(byLabel(view.container, "Next story"));
		await click(byLabel(view.container, "Read: Release notes"));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.dispose();
	});

	test("shows the host thread view in a panel that Escape closes", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			lobby(port, {
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread">host</div>,
			})
		);
		const panel = view.container.querySelector(
			"[data-testid='lobby-thread-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Crash triage");
		expect(panel?.querySelector("[data-testid='host-thread']")).not.toBeNull();
		await press(panel, "Escape");
		expect(calls).toEqual(["close"]);
		await click(byLabel(view.container, "Close thread"));
		expect(calls).toEqual(["close", "close"]);
		await view.dispose();
	});

	test("leaves Escape on <body> to the host's cover", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			lobby(port, {
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread">host</div>,
			})
		);
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the lobby it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("loading shows placeholders, and no agents shows an empty state", async () => {
		const { calls, port } = recordingPort();
		const loading = renderToStaticMarkup(lobby(port, { loading: true }));
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('aria-label="Level loading"');

		const view = await mount(
			lobby(port, {
				snapshot: { agents: [], groups: [], threads: [], version: 1 },
			})
		);
		expect(view.container.textContent).toContain("Your squad is empty");
		const start = [...view.container.querySelectorAll("button")].find(
			(button) => button.textContent === "New thread"
		);
		await click(start);
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});
});

describe("lobby settings", () => {
	const squadOf = (container: HTMLElement) =>
		[...container.querySelectorAll<HTMLElement>("[aria-label]")]
			.map((element) => element.getAttribute("aria-label") ?? "")
			.find((label) => /^Squad \d+ of \d+\. Edit squad\.$/.test(label));
	const selectedTab = (container: HTMLElement) =>
		[...container.querySelectorAll<HTMLElement>("[role='tab']")]
			.find((element) => element.getAttribute("aria-selected") === "true")
			?.textContent?.trim();

	test("defaults: a squad of four, opening on the lobby", async () => {
		const { port } = recordingPort();
		const view = await mount(lobby(port));
		expect(squadOf(view.container)).toMatch(/ of 4\./);
		expect(selectedTab(view.container)).toStartWith("Lobby");
		await view.dispose();
	});

	test("overrides set the squad size and the opening tab; live changes apply", async () => {
		const { port } = recordingPort();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(lobby(port, { params: { squadSize: 2 } }))
		);
		expect(squadOf(container)).toBe("Squad 2 of 2. Edit squad.");
		await act(async () =>
			root.render(lobby(port, { params: { openOn: "news", squadSize: 3 } }))
		);
		expect(selectedTab(container)).toStartWith("News");
		await act(async () => root.render(lobby(port, { params: {} })));
		expect(selectedTab(container)).toStartWith("Lobby");
		expect(squadOf(container)).toMatch(/ of 4\./);
		await act(async () => root.unmount());
		container.remove();
	});

	test("switching tabs keeps the last one through updateSettings", async () => {
		const updates: Record<string, unknown>[] = [];
		const { port } = recordingPort();
		const view = await mount(
			lobby({ ...port, updateSettings: (patch) => updates.push(patch) })
		);
		await click(tab(view.container, "Quests"));
		expect(updates).toEqual([{ openOn: "quests" }]);
		expect(tab(view.container, "Quests")?.getAttribute("aria-selected")).toBe(
			"true"
		);
		await view.dispose();
	});
});
