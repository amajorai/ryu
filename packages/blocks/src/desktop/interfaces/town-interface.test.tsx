import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAgent,
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { hasReducedMotionListener, prefersReducedMotion } from "motion/react";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { petitionLabel } from "./town-desk.tsx";
import { TownInterface } from "./town-interface.tsx";
import {
	ACTIVITY_FULL,
	activityWeight,
	agentSchedule,
	blockCells,
	buildingFloors,
	buildingKind,
	buildingLabel,
	buildTown,
	formatFunds,
	happiness,
	heatLevels,
	homeDistrict,
	OLD_TOWN_ID,
	roadLines,
	spokenAge,
	townFrame,
} from "./town-model.ts";
import {
	cssRgb,
	EMPTY_THEME,
	hashId,
	mixHex,
	pickById,
	rampColor,
	townPalette,
} from "./town-palette.ts";

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

function agent(
	id: string,
	name: string,
	status: InterfaceAgent["status"] = "idle"
): InterfaceAgent {
	return {
		avatarUrl: null,
		description: `${name} does things`,
		id,
		name,
		status,
	};
}

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
		agentId: "agent-delta",
		end: ago(170),
		id: "run-past",
		kind: "past",
		label: "Daily at 6 AM",
		outcome: "success",
		start: ago(180),
		title: "Backup check",
	},
	{
		agentId: "agent-delta",
		id: "run-next",
		kind: "upcoming",
		label: "Daily at 6 AM",
		start: new Date(NOW + 120 * MINUTE).toISOString(),
		title: "Backup check",
	},
	{
		agentId: "agent-echo",
		id: "run-echo",
		kind: "upcoming",
		label: "Every hour",
		start: new Date(NOW + 30 * MINUTE).toISOString(),
		title: "Inbox sweep",
	},
];

const SNAPSHOT: InterfaceSnapshot = {
	account: {
		balance: 18_420_000,
		breakdown: null,
		currency: "usd",
		transactions: [],
	},
	agents: [
		agent("agent-atlas", "Atlas"),
		agent("agent-brook", "Brook"),
		agent("agent-cipher", "Cipher"),
		agent("agent-delta", "Delta", "working"),
		agent("agent-echo", "Echo"),
		agent("agent-forge", "Forge", "working"),
	],
	events: EVENTS,
	groups: [
		{
			id: "team-launch",
			kind: "team",
			memberAgentIds: ["agent-atlas", "agent-echo", "agent-forge"],
			name: "Launch Crew",
		},
		{
			id: "project-website",
			kind: "project",
			memberAgentIds: ["agent-brook", "agent-forge"],
			name: "Website Redesign",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-forge"],
			id: "thread-hero",
			messageCount: 9,
			projectId: "project-website",
			running: true,
			title: "Rebuild the landing hero",
			updatedAt: ago(1),
		}),
		thread({
			agentIds: ["agent-delta"],
			id: "thread-deploy",
			messageCount: 14,
			running: true,
			title: "Roll out gateway 2.4",
			updatedAt: ago(3),
		}),
		thread({
			agentIds: ["agent-atlas", "agent-echo", "agent-forge"],
			id: "thread-launch",
			messageCount: 22,
			teamId: "team-launch",
			title: "Launch week plan",
			updatedAt: ago(18),
		}),
		thread({
			agentIds: ["agent-brook"],
			id: "thread-palette",
			messageCount: 6,
			projectId: "project-website",
			title: "Pick a palette",
			updatedAt: ago(42),
		}),
		thread({
			agentIds: ["agent-cipher"],
			id: "thread-audit",
			messageCount: 5,
			runState: "failed",
			title: "Audit lockfile advisories",
			updatedAt: ago(95),
		}),
		thread({
			agentIds: ["agent-echo"],
			id: "thread-notes",
			messageCount: 4,
			title: "Draft release notes",
			updatedAt: ago(160),
		}),
		thread({
			agentIds: ["agent-atlas"],
			id: "thread-research",
			lastMessageRole: "user",
			messageCount: 4,
			title: "Survey papers",
			updatedAt: ago(60 * 7),
		}),
		thread({
			agentIds: ["agent-echo"],
			id: "thread-style",
			title: "Changelog style guide",
			updatedAt: ago(60 * 26),
		}),
		thread({
			agentIds: [],
			id: "thread-general",
			lastMessageRole: "user",
			messageCount: 1,
			title: "Office closed Friday",
			updatedAt: ago(60 * 24 * 9),
		}),
	],
	version: 1,
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
// happy-dom has no Web Animations; the panel's scroll area asks for them.
if (!("getAnimations" in Element.prototype)) {
	Reflect.set(Element.prototype, "getAnimations", () => []);
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

function buttonNamed(container: HTMLElement, name: string | RegExp) {
	return [...container.querySelectorAll("button")].find((candidate) => {
		const label =
			candidate.getAttribute("aria-label") ??
			candidate.textContent?.trim() ??
			"";
		return typeof name === "string" ? label === name : name.test(label);
	});
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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function props(overrides: Partial<Parameters<typeof TownInterface>[0]> = {}) {
	return {
		activeThreadId: null,
		loading: false,
		params: {},
		port: recordingPort().port,
		snapshot: SNAPSHOT,
		threadView: null,
		...overrides,
	};
}

describe("town model", () => {
	test("projects and teams are districts; agents in neither live in Old Town", () => {
		const town = buildTown(SNAPSHOT, NOW);
		const residents = Object.fromEntries(
			town.districts.map((district) => [
				district.name,
				district.buildings.map((building) => building.agent.name).sort(),
			])
		);
		expect(residents).toEqual({
			"Launch Crew": ["Atlas", "Echo"],
			"Old Town": ["Cipher", "Delta"],
			// Forge is in both; a tie goes to the project.
			"Website Redesign": ["Brook", "Forge"],
		});
		expect(homeDistrict("agent-forge", SNAPSHOT.groups, SNAPSHOT.threads)).toBe(
			"project-website"
		);
		expect(homeDistrict("agent-cipher", SNAPSHOT.groups, [])).toBe(OLD_TOWN_ID);
		// Ungrouped threads follow their agent home; agentless ones go to Old Town.
		const launch = town.districts.find((item) => item.id === "team-launch");
		expect(launch?.threads.map((item) => item.id).sort()).toEqual([
			"thread-launch",
			"thread-notes",
			"thread-research",
			"thread-style",
		]);
		const oldTown = town.districts.find((item) => item.id === OLD_TOWN_ID);
		expect(oldTown?.threads.map((item) => item.id)).toContain("thread-general");
	});

	test("buildings grow from cottage to shop to tower with conversations", () => {
		expect(buildingKind(0)).toBe("cottage");
		expect(buildingKind(1)).toBe("cottage");
		expect(buildingKind(2)).toBe("shop");
		expect(buildingKind(3)).toBe("tower");
		expect(buildingFloors("cottage", 2)).toBe(1);
		expect(buildingFloors("cottage", 8)).toBe(2);
		expect(buildingFloors("shop", 10)).toBe(2);
		expect(buildingFloors("shop", 20)).toBe(3);
		expect(buildingFloors("tower", 0)).toBe(4);
		expect(buildingFloors("tower", 200)).toBe(8);
		const town = buildTown(SNAPSHOT, NOW);
		const kinds = Object.fromEntries(
			town.buildings.map((building) => [building.agent.name, building.kind])
		);
		expect(kinds).toEqual({
			Atlas: "shop",
			Brook: "cottage",
			Cipher: "cottage",
			Delta: "cottage",
			Echo: "tower",
			Forge: "shop",
		});
	});

	test("status marks: crane while working, beacon on failure, bubble on a reply", () => {
		const town = buildTown(SNAPSHOT, NOW);
		const by = (name: string) =>
			town.buildings.find((building) => building.agent.name === name);
		expect(by("Forge")?.working).toBe(true);
		expect(by("Delta")?.working).toBe(true);
		expect(by("Cipher")?.alert).toBe(true);
		expect(by("Cipher")?.replied).toBe(false);
		expect(by("Brook")?.replied).toBe(true);
		expect(by("Atlas")?.replied).toBe(true);
		expect(by("Echo")?.counts["your-turn"]).toBe(3);
		// More agents at work, more traffic.
		expect(town.cars).toBe(8);
		expect(buildTown({ ...SNAPSHOT, agents: [] }, NOW).cars).toBe(0);
	});

	test("petitions are what waits on you, failed runs first, newest next", () => {
		const town = buildTown(SNAPSHOT, NOW);
		expect(
			town.petitions.map((petition) => [petition.thread.id, petition.status])
		).toEqual([
			["thread-audit", "attention"],
			["thread-launch", "your-turn"],
			["thread-palette", "your-turn"],
			["thread-notes", "your-turn"],
			["thread-style", "your-turn"],
		]);
		const [first] = town.petitions;
		expect(first?.agent?.name).toBe("Cipher");
		expect(first?.districtName).toBe("Old Town");
		if (first) {
			expect(petitionLabel(first, NOW)).toBe(
				"Hear petition: Audit lockfile advisories. Run failed, from Cipher, Old Town, 2 hours ago"
			);
		}
	});

	test("the HUD: population, happiness, construction and funds", () => {
		const { stats } = buildTown(SNAPSHOT, NOW);
		expect(stats.population).toBe(9);
		expect(stats.working).toBe(2);
		expect(stats.yourTurn).toBe(4);
		expect(stats.attention).toBe(1);
		expect(stats.happiness).toBe(happiness(9, 4, 1));
		expect(happiness(0, 0, 0)).toBe(100);
		expect(happiness(10, 0, 0)).toBe(100);
		expect(happiness(10, 4, 1)).toBe(57);
		expect(happiness(2, 10, 10)).toBe(0);
		expect(formatFunds(SNAPSHOT)).toBe("$18.42");
		expect(formatFunds(EMPTY)).toBeNull();
	});

	test("districts sit around City Hall, busiest facing the camera; the rest are parks", () => {
		const cells = blockCells(3);
		expect(cells).toHaveLength(8);
		expect(cells.slice(0, 4)).toEqual([
			{ col: 1, row: 0 },
			{ col: 0, row: 1 },
			{ col: 0, row: -1 },
			{ col: -1, row: 0 },
		]);
		expect(blockCells(5)).toHaveLength(24);
		const town = buildTown(SNAPSHOT, NOW);
		expect(town.grid.blocks).toBe(3);
		expect(town.parks).toHaveLength(5);
		expect(roadLines(town.grid)).toHaveLength(4);
		// The whole island is framed, evenly round City Hall; a phone frames
		// only the district blocks.
		const frame = townFrame(town);
		expect(frame.minX).toBe(-frame.maxX);
		expect(frame.maxX).toBeGreaterThan(town.grid.reach);
		const districts = townFrame(town, "districts");
		expect(districts.maxX - districts.minX).toBeLessThan(
			frame.maxX - frame.minX
		);
		// Nine groups need the bigger grid.
		const many = buildTown(
			{
				...SNAPSHOT,
				groups: Array.from({ length: 9 }, (_, index) => ({
					id: `team-${index}`,
					kind: "team" as const,
					memberAgentIds: [],
					name: `Team ${index}`,
				})),
			},
			NOW
		);
		expect(many.grid.blocks).toBe(5);
	});

	test("districts fill lots as they grow; the rest stay zoned and empty", () => {
		const town = buildTown(SNAPSHOT, NOW);
		for (const district of town.districts) {
			const lots =
				district.buildings.length +
				district.fillers.length +
				district.emptyLots.length;
			expect(lots).toBe(town.grid.lots ** 2);
			expect(district.fillers.length).toBe(
				Math.min(lots - district.buildings.length, district.threads.length)
			);
		}
		const website = town.districts.find(
			(item) => item.id === "project-website"
		);
		expect(website?.emptyLots.length).toBe(5);
		// Lot assignment never puts two things on one lot.
		const used = new Set<string>();
		for (const district of town.districts) {
			for (const lot of [
				...district.buildings.map((item) => item.lot),
				...district.fillers.map((item) => item.lot),
				...district.emptyLots,
			]) {
				const key = `${lot.x}:${lot.z}`;
				expect(used.has(key)).toBe(false);
				used.add(key);
			}
		}
	});

	test("data views: activity from fresh and live conversations, needs from petitions", () => {
		expect(activityWeight(thread({ id: "a", running: true }), NOW)).toBe(2);
		expect(activityWeight(thread({ id: "b", updatedAt: ago(5) }), NOW)).toBe(
			0.8
		);
		expect(
			activityWeight(thread({ id: "c", updatedAt: ago(60 * 24 * 30) }), NOW)
		).toBe(0.05);
		expect(activityWeight(thread({ id: "d", updatedAt: "nope" }), NOW)).toBe(0);
		const town = buildTown(SNAPSHOT, NOW);
		for (const district of town.districts) {
			expect(district.activity).toBeGreaterThanOrEqual(0);
			expect(district.activity).toBeLessThanOrEqual(1);
		}
		const website = town.districts.find(
			(item) => item.id === "project-website"
		);
		const busiest = Math.max(...town.districts.map((item) => item.activity));
		expect(busiest).toBeGreaterThan(0);
		expect(website?.activity).toBeGreaterThan(0);
		const launch = town.districts.find((item) => item.id === "team-launch");
		// Launch Crew has the most replies waiting: the top of the needs view.
		expect(launch?.needs).toBe(1);
	});

	test("heat spreads districts over stepped bins, capped by the busiest", () => {
		expect(heatLevels([], ACTIVITY_FULL)).toEqual([]);
		// Near-equal districts keep their absolute level.
		expect(heatLevels([1.5, 1.5], ACTIVITY_FULL)).toEqual([0.5, 0.5]);
		const [low, mid, high] = heatLevels([0.6, 1.8, 3.6], ACTIVITY_FULL);
		expect(high).toBe(1);
		expect(low).toBeCloseTo(0.12);
		expect(mid).toBeGreaterThan(low ?? 0);
		expect(mid).toBeLessThan(high ?? 0);
		// A sleepy town stays cool even at the top of its range.
		const sleepy = heatLevels([0.05, 0.6], ACTIVITY_FULL);
		expect(Math.max(...sleepy)).toBeCloseTo(0.2);
		// An idle district beside a busy one stays cold, not the lowest bin.
		const [idle, busy] = heatLevels([0, 3.6], ACTIVITY_FULL);
		expect(idle).toBe(0);
		expect(busy).toBe(1);
	});

	test("an empty snapshot is City Hall among parks", () => {
		const town = buildTown(EMPTY, NOW);
		expect(town.districts).toEqual([]);
		expect(town.parks).toHaveLength(8);
		expect(town.stats.happiness).toBe(100);
		expect(town.petitions).toEqual([]);
	});

	test("schedules, labels and ages", () => {
		const schedule = agentSchedule(EVENTS, "agent-delta");
		expect(schedule.upcoming.map((event) => event.id)).toEqual(["run-next"]);
		expect(schedule.recent.map((event) => event.id)).toEqual(["run-past"]);
		expect(agentSchedule(undefined, "agent-delta").upcoming).toEqual([]);
		const town = buildTown(SNAPSHOT, NOW);
		const cipher = town.buildings.find(
			(building) => building.agent.id === "agent-cipher"
		);
		if (cipher) {
			expect(buildingLabel(cipher, "Old Town")).toBe(
				"Cipher's cottage, Old Town, 1 conversation, 1 failed run"
			);
		}
		expect(spokenAge(ago(0), NOW)).toBe("just now");
		expect(spokenAge(ago(1), NOW)).toBe("1 minute ago");
		expect(spokenAge(ago(60 * 50), NOW)).toBe("2 days ago");
		expect(spokenAge("nope", NOW)).toBe("");
	});
});

describe("town palette", () => {
	test("light themes are a sunny day; dark themes are night", () => {
		expect(townPalette(EMPTY_THEME).mode).toBe("light");
		expect(townPalette({ ...EMPTY_THEME, darkClass: true }).mode).toBe("dark");
		const night = townPalette({ ...EMPTY_THEME, background: [12, 12, 16] });
		expect(night.mode).toBe("dark");
		// The island sits in its own sea, edge to edge, in either mood.
		expect(night.background).toBe(night.sea);
		expect(night.sea).not.toBe(townPalette(EMPTY_THEME).sea);
		const themed = townPalette({
			...EMPTY_THEME,
			background: [250, 250, 250],
			destructive: [200, 10, 10],
			primary: [10, 20, 200],
		});
		expect(themed.status.alert).toBe(cssRgb([200, 10, 10]));
		expect(themed.status.reply).toBe(cssRgb([10, 20, 200]));
	});

	test("ramps and mixing", () => {
		const ramp = townPalette(EMPTY_THEME).ramps.needs;
		expect(rampColor(ramp, 0)).toBe(ramp[0]);
		expect(rampColor(ramp, 0.5)).toBe(ramp[1]);
		expect(rampColor(ramp, 1)).toBe(ramp[2]);
		expect(rampColor(ramp, 7)).toBe(ramp[2]);
		expect(mixHex(ramp[0], ramp[2], 0)).toBe(ramp[0]);
		expect(mixHex(ramp[0], ramp[2], 1)).toBe(ramp[2]);
		expect(mixHex(ramp[1], ramp[1], 0.5)).toBe(ramp[1]);
		expect(hashId("agent-echo")).toBe(hashId("agent-echo"));
		expect(pickById([], "x")).toBeUndefined();
		expect(pickById(["a", "b"], "x")).toBe(pickById(["a", "b"], "x"));
	});
});

describe("TownInterface", () => {
	test("renders the mayor's HUD and the petitions desk", () => {
		const markup = renderToStaticMarkup(<TownInterface {...props()} />);
		expect(markup).toContain('data-testid="interface-town"');
		expect(markup).toContain("Population");
		expect(markup).toContain("Happiness");
		expect(markup).toContain('role="meter"');
		expect(markup).toContain("Under construction");
		expect(markup).toContain("$18.42");
		// The desk folds into the City Hall plate until it is opened.
		expect(markup).toContain('aria-label="City Hall, 5 petitions"');
		expect(markup).not.toContain("Hear petition: Audit lockfile advisories");
		expect(markup).toContain('aria-label="Simulation speed"');
		expect(markup).not.toContain("<canvas");
	});

	test("the City Hall plate opens the petitions desk", async () => {
		const view = await mount(<TownInterface {...props()} />);
		await click(buttonNamed(view.container, "City Hall, 5 petitions"));
		expect(view.container.textContent).toContain("Petitions");
		expect(
			buttonNamed(view.container, /^Hear petition: Audit lockfile advisories/)
		).toBeDefined();
		await view.dispose();
	});

	test("loading shows skeletons; an empty town offers to found it", async () => {
		const loading = renderToStaticMarkup(
			<TownInterface {...props({ loading: true })} />
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("Laying out the town");
		expect(loading).not.toContain("Hear petition");

		const { calls, port } = recordingPort();
		const view = await mount(
			<TownInterface {...props({ port, snapshot: EMPTY })} />
		);
		expect(view.container.textContent).toContain("No one lives here yet");
		await click(buttonNamed(view.container, "City Hall, 0 petitions"));
		expect(view.container.textContent).toContain("Nothing is waiting on you");
		await click(buttonNamed(view.container, "Start a conversation"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("hearing a petition opens its conversation through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<TownInterface {...props({ port })} />);
		await click(buttonNamed(view.container, "City Hall, 5 petitions"));
		await click(buttonNamed(view.container, /^Hear petition: Pick a palette/));
		expect(calls).toEqual(["open:thread-palette"]);
		await view.dispose();
	});

	test("without WebGL every building is listed; its card commissions work", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<TownInterface {...props({ port })} />);
		expect(view.container.textContent).toContain("The 3D town needs WebGL");
		const buildings = [...view.container.querySelectorAll("button")].filter(
			(button) => /Open its card$/.test(button.getAttribute("aria-label") ?? "")
		);
		expect(buildings).toHaveLength(6);
		await click(buttonNamed(view.container, /^Echo's office tower/));
		const card = view.container.querySelector('[data-town-panel="building"]');
		expect(card?.getAttribute("aria-label")).toBe("Echo's office tower");
		expect(card?.textContent).toContain("Office tower · Launch Crew");
		expect(card?.textContent).toContain("3 replies waiting on you");
		expect(card?.textContent).toContain("Inbox sweep");
		expect(document.activeElement?.textContent).toBe("Echo");

		const field = card?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the commission field");
		}
		await typeInto(field, "   ");
		await press(field, "Enter");
		expect(calls).toEqual([]);
		await typeInto(field, "  Draft the 2.5 notes ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-echo","prompt":"Draft the 2.5 notes"}',
		]);

		await click(buttonNamed(view.container, /^Launch week plan\./));
		expect(calls.at(-1)).toBe("open:thread-launch");
		await view.dispose();
	});

	test("an open thread is the host's view under a council record", async () => {
		const { calls, port } = recordingPort();
		const threadView = <div data-testid="host-thread">host chat</div>;
		const view = await mount(
			<TownInterface
				{...props({ activeThreadId: "thread-audit", port, threadView })}
			/>
		);
		const record = view.container.querySelector('[data-town-panel="thread"]');
		expect(record?.getAttribute("aria-label")).toBe(
			"Council record: Audit lockfile advisories"
		);
		expect(record?.textContent).toContain("Needs attention");
		expect(record?.textContent).toContain("Petition · Old Town · filed 1h ago");
		expect(record?.textContent).toContain("From Cipher · 5 messages");
		expect(record?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		await click(buttonNamed(view.container, "Back to Cipher's cottage"));
		expect(calls).toEqual(["close"]);
		await view.rerender(
			<TownInterface {...props({ port, threadView: null })} />
		);
		const card = view.container.querySelector('[data-town-panel="building"]');
		expect(card?.getAttribute("aria-label")).toBe("Cipher's cottage");
		const heading = card?.querySelector("h2");
		if (!heading) {
			throw new Error("Expected the card heading");
		}
		await press(heading, "Escape");
		expect(view.container.querySelector("[data-town-panel]")).toBeNull();
		await view.dispose();
	});

	test("a host page over the town keeps its Escape", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TownInterface
				{...props({
					activeThreadId: "thread-audit",
					port,
					threadView: <div>host chat</div>,
				})}
			/>
		);
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the town it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("the speed control pauses and resumes the clock", async () => {
		const view = await mount(<TownInterface {...props()} />);
		const pause = buttonNamed(view.container, "Pause");
		const play = buttonNamed(view.container, "Normal speed");
		expect(play?.getAttribute("aria-pressed")).toBe("true");
		await click(pause);
		expect(pause?.getAttribute("aria-pressed")).toBe("true");
		expect(play?.getAttribute("aria-pressed")).toBe("false");
		await view.dispose();
	});

	test("the speed is a setting: from params, saved from the HUD, live from Settings", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const pressed = (container: HTMLElement, name: string) =>
			buttonNamed(container, name)?.getAttribute("aria-pressed");
		// The default: normal speed.
		const plain = await mount(<TownInterface {...props({ port })} />);
		expect(pressed(plain.container, "Normal speed")).toBe("true");
		await plain.dispose();
		// An override from the interface's params.
		const view = await mount(
			<TownInterface {...props({ params: { speed: "fast" }, port })} />
		);
		expect(pressed(view.container, "Fast")).toBe("true");
		// The HUD's control changes the clock at once and saves the choice.
		await click(buttonNamed(view.container, "Pause"));
		expect(pressed(view.container, "Pause")).toBe("true");
		expect(saved).toEqual([{ speed: "paused" }]);
		// A change from Settings (new params) takes over, live.
		await view.rerender(
			<TownInterface {...props({ params: { speed: "normal" }, port })} />
		);
		expect(pressed(view.container, "Normal speed")).toBe("true");
		await view.dispose();
	});

	test("under reduced motion only an automatic speed opens paused", async () => {
		const pressed = (container: HTMLElement, name: string) =>
			buttonNamed(container, name)?.getAttribute("aria-pressed");
		// Motion reads the media query once (in a browser, at import); set the
		// state it keeps directly, then put it back.
		const saved = {
			listener: hasReducedMotionListener.current,
			prefers: prefersReducedMotion.current,
		};
		hasReducedMotionListener.current = true;
		prefersReducedMotion.current = true;
		try {
			const auto = await mount(<TownInterface {...props()} />);
			expect(pressed(auto.container, "Pause")).toBe("true");
			await auto.dispose();
			const explicit = await mount(
				<TownInterface {...props({ params: { speed: "normal" } })} />
			);
			expect(pressed(explicit.container, "Normal speed")).toBe("true");
			await explicit.dispose();
		} finally {
			hasReducedMotionListener.current = saved.listener;
			prefersReducedMotion.current = saved.prefers;
		}
	});
});
