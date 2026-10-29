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
import { ArcadeInterface, arcadeLights } from "./arcade-interface.tsx";
import {
	bankHeight,
	bankWidth,
	buildFloor,
	composeInput,
	floorFit,
	MAX_FLOOR_ZOOM,
	MIN_FLOOR_ZOOM,
	machineForThread,
	marqueeBulbs,
	marqueeFontSize,
	meterDigits,
	nextJackpot,
	paytable,
	reelLabel,
	sharedWith,
	snapshotNow,
	spinningReels,
	wallCabinetLabel,
} from "./arcade-model.ts";

const MINUTE = 60_000;
// Relative to now, so "fresh" replies stay fresh whenever the suite runs.
const BASE = Date.now();
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
			description: "Designs pages",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Ships builds",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Writes copy",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-linus"],
			name: "Docs Crew",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-palette",
			messageCount: 6,
			projectId: "project-site",
			title: "Pick a palette",
			updatedAt: ago(40),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-old",
			messageCount: 3,
			title: "Older reply",
			updatedAt: ago(400),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-hero",
			messageCount: 9,
			projectId: "project-site",
			running: true,
			title: "Landing hero",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-audit",
			messageCount: 5,
			runState: "failed",
			title: "Audit",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-notes",
			lastMessageRole: "user",
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			messageCount: 1,
			title: "",
			updatedAt: ago(600),
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
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
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

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
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

function arcade(
	port: InterfacePort,
	overrides: Partial<Parameters<typeof ArcadeInterface>[0]> = {}
) {
	return (
		<ArcadeInterface
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

describe("arcade model", () => {
	test("one machine per agent; agentless threads still count", () => {
		const floor = buildFloor(SNAPSHOT, null, BASE);
		expect(floor.machines.map((machine) => machine.id)).toEqual([
			"agent-ada",
			"agent-grace",
			"agent-linus",
		]);
		const [ada, grace, linus] = floor.machines;
		// Reels are the three newest conversations; missing ones are blank.
		expect(ada?.reels.map((reel) => reel.symbol)).toEqual([
			"bell",
			"bell",
			"blank",
		]);
		expect(grace?.reels.map((reel) => reel.symbol)).toEqual([
			"seven",
			"flame",
			"blank",
		]);
		expect(linus?.reels[0]?.symbol).toBe("bar");
		expect(ada?.credits).toBe(9);
		expect(ada?.jackpots.map((item) => item.id)).toEqual([
			"thread-palette",
			"thread-old",
		]);
		expect(grace?.running).toBe(true);
		expect(grace?.tilt?.id).toBe("thread-audit");
		expect(ada?.tilt).toBeNull();
		// The agentless thread has no machine but is on the meters.
		expect(floor.threads.map((item) => item.id)).toContain("thread-loose");
		expect(floor.totals).toEqual({
			credits: 26,
			jackpots: 2,
			machines: 3,
			running: 1,
			tilts: 1,
		});
	});

	test("only a fresh reply on the pay line lights the jackpot topper", () => {
		const [ada, grace, linus] = buildFloor(SNAPSHOT, null, BASE).machines;
		expect(ada?.hot).toBe(true);
		// Grace's newest conversation is a live run, Linus's waits on the agent.
		expect(grace?.hot).toBe(false);
		expect(linus?.hot).toBe(false);
		// A day later the same reply only lights the WIN meter.
		const later = buildFloor(SNAPSHOT, null, BASE + 24 * 60 * MINUTE);
		expect(later.machines[0]?.hot).toBe(false);
		expect(later.machines[0]?.jackpots).toHaveLength(2);
	});

	test("a fresh reply is judged by the snapshot's clock, not the wall's", () => {
		// The newest conversation (Grace's live run) sets the floor's clock.
		expect(snapshotNow(SNAPSHOT)).toBe(BASE - 2 * MINUTE);
		const replay: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) => ({
				...item,
				updatedAt: new Date(
					Date.parse(item.updatedAt) - 30 * 24 * 60 * MINUTE
				).toISOString(),
			})),
		};
		// A month-old snapshot still reads the same: Ada's reply is fresh.
		expect(buildFloor(replay, null).machines[0]?.hot).toBe(true);
		expect(snapshotNow({ ...SNAPSHOT, threads: [] })).toBe(0);
	});

	test("a shared conversation has a ticket on every member's machine", () => {
		const shared: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) =>
				item.id === "thread-palette"
					? { ...item, agentIds: ["agent-ada", "agent-linus"] }
					: item
			),
		};
		const floor = buildFloor(shared, null);
		const [ada, grace, linus] = floor.machines;
		if (!(ada && grace && linus)) {
			throw new Error("Expected three machines");
		}
		// Every bell on a reel has a ticket in that machine's tray.
		for (const machine of floor.machines) {
			const bells = machine.reels
				.filter((reel) => reel.symbol === "bell")
				.map((reel) => reel.thread?.id ?? "");
			const tickets = machine.jackpots.map((item) => item.id);
			for (const id of bells) {
				expect(tickets).toContain(id);
			}
		}
		expect(linus.jackpots.map((item) => item.id)).toContain("thread-palette");
		const ticket = ada.jackpots[0];
		if (!ticket) {
			throw new Error("Expected Ada's ticket");
		}
		expect(sharedWith(ticket, ada, shared.agents)).toEqual(["Linus"]);
		expect(sharedWith(ticket, linus, shared.agents)).toEqual(["Ada"]);
		// The HUD counts the reply once; credits stay with the lead machine.
		expect(floor.totals.jackpots).toBe(2);
		expect(linus.credits).toBe(2);
		expect(ada.credits + grace.credits + linus.credits).toBe(
			floor.totals.credits - 1
		);
	});

	test("a quiet conversation lands on the cherry; only an empty reel is blank", () => {
		const quiet: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({
					agentIds: ["agent-linus"],
					id: "thread-quiet",
					lastMessageRole: null,
					messageCount: 0,
					title: "Quiet",
				}),
			],
		};
		const linus = buildFloor(quiet, null).machines[2];
		expect(linus?.reels.map((reel) => reel.symbol)).toEqual([
			"cherry",
			"blank",
			"blank",
		]);
	});

	test("only working reels spin; the rest stay settled", () => {
		const [ada, grace] = buildFloor(SNAPSHOT, null).machines;
		if (!(ada && grace)) {
			throw new Error("Expected machines");
		}
		expect(spinningReels(grace, false)).toEqual([true, false, false]);
		expect(spinningReels(ada, false)).toEqual([false, false, false]);
		// A message just went in: every reel runs, then settles.
		expect(spinningReels(ada, true)).toEqual([true, true, true]);
		// A busy agent with nothing working on its reels runs the first one.
		const busy = { ...ada, running: true };
		expect(spinningReels(busy, false)).toEqual([true, false, false]);
	});

	test("a wall cabinet filters the floor to its agents", () => {
		const floor = buildFloor(SNAPSHOT, "project-site");
		expect(floor.filter?.name).toBe("Website");
		expect(floor.machines.map((machine) => machine.id)).toEqual([
			"agent-ada",
			"agent-grace",
		]);
		const [site, docs] = floor.wall;
		if (!site) {
			throw new Error("Expected the Website cabinet");
		}
		expect(site).toMatchObject({ jackpots: 1, machines: 2, running: 1 });
		expect(docs).toMatchObject({ jackpots: 0, machines: 1, running: 0 });
		expect(wallCabinetLabel(site, false)).toBe(
			"Show project Website: 2 machines, 1 waiting on you, 1 running"
		);
		// An unknown group shows the whole floor.
		expect(buildFloor(SNAPSHOT, "nope").filter).toBeNull();
	});

	test("machine finishes and marquees are deterministic per agent", () => {
		const first = buildFloor(SNAPSHOT, null).machines[0];
		const again = buildFloor(SNAPSHOT, null).machines[0];
		expect(first?.skin).toBe(again?.skin ?? -1);
		expect(first?.marquee).toBe(again?.marquee ?? "flat");
	});

	test("the next jackpot is the reply that has waited longest", () => {
		expect(nextJackpot(buildFloor(SNAPSHOT, null))?.id).toBe("thread-old");
		expect(nextJackpot(buildFloor(SNAPSHOT, "team-docs"))).toBeUndefined();
	});

	test("a pulled lever names the agent and files under the filter", () => {
		const floor = buildFloor(SNAPSHOT, "team-docs");
		const linus = floor.machines[0];
		if (!linus) {
			throw new Error("Expected Linus");
		}
		expect(composeInput(linus, floor.filter, "Hi")).toEqual({
			agentId: "agent-linus",
			prompt: "Hi",
			teamId: "team-docs",
		});
		expect(composeInput(linus, null, "Hi")).toEqual({
			agentId: "agent-linus",
			prompt: "Hi",
		});
	});

	test("open threads map back to their machine", () => {
		const floor = buildFloor(SNAPSHOT, null);
		const loose = SNAPSHOT.threads.find((item) => item.id === "thread-loose");
		const hero = SNAPSHOT.threads.find((item) => item.id === "thread-hero");
		expect(machineForThread(floor, loose)).toBeUndefined();
		expect(machineForThread(floor, hero)?.id).toBe("agent-grace");
		expect(machineForThread(floor, undefined)).toBeUndefined();
		// The machine it was cashed from wins, if that machine holds it.
		if (!hero) {
			throw new Error("Expected the hero thread");
		}
		const shared = { ...hero, agentIds: ["agent-ada", "agent-grace"] };
		expect(machineForThread(floor, shared)?.id).toBe("agent-ada");
		expect(machineForThread(floor, shared, "agent-grace")?.id).toBe(
			"agent-grace"
		);
		expect(machineForThread(floor, hero, "agent-ada")?.id).toBe("agent-grace");
	});

	test("the paytable counts each symbol once per conversation", () => {
		const lines = paytable(buildFloor(SNAPSHOT, null));
		expect(
			Object.fromEntries(lines.map((line) => [line.symbol, line.count]))
		).toEqual({ bar: 2, bell: 2, cherry: 0, flame: 1, seven: 1 });
	});

	test("the aisle shows a few big machines and scrolls for the rest", () => {
		// 1440 x 900: four machines in view, two more down the aisle.
		const wide = floorFit(6, 1392, 600);
		expect(wide).toMatchObject({
			columns: 6,
			overflow: true,
			rows: 1,
			view: 4,
		});
		expect(wide.zoom).toBeGreaterThanOrEqual(1.3);
		expect(bankWidth(wide.view) * wide.zoom).toBeLessThanOrEqual(1392);
		expect(bankHeight(1) * wide.zoom).toBeLessThanOrEqual(600);
		// Few machines on a big floor grow, but not past the cap.
		expect(floorFit(2, 1392, 900)).toMatchObject({
			overflow: false,
			view: 2,
			zoom: MAX_FLOOR_ZOOM,
		});
		// A short floor shrinks them to its height.
		expect(floorFit(3, 1392, 300).zoom).toBeLessThan(1);
		// Narrow floors keep machines legible by showing fewer at a time.
		const medium = floorFit(6, 852, 600);
		expect(medium.view).toBe(3);
		expect(medium.zoom).toBeGreaterThanOrEqual(1.15);
		const narrow = floorFit(6, 600, 700);
		expect(narrow.view).toBe(2);
		expect(narrow.zoom).toBeGreaterThanOrEqual(MIN_FLOOR_ZOOM);
		// Phones show one machine at a time.
		expect(floorFit(4, 342, 600)).toMatchObject({ overflow: true, view: 1 });
		expect(floorFit(0, 900, 900)).toEqual({
			columns: 1,
			overflow: false,
			rows: 1,
			view: 1,
			zoom: 1,
		});
	});

	test("long names shrink to fit the marquee", () => {
		expect(marqueeFontSize("Atlas", 160, 22, 13)).toBe(22);
		const long = marqueeFontSize("Website Redesign", 144, 13, 10);
		expect(long).toBeLessThan(13);
		expect(long).toBeGreaterThanOrEqual(10);
		expect(marqueeFontSize("A very long agent name indeed", 160, 22, 13)).toBe(
			13
		);
	});

	test("meters, reel labels and bulbs", () => {
		expect(meterDigits(74)).toBe("0074");
		expect(meterDigits(3, 2)).toBe("03");
		const reel = buildFloor(SNAPSHOT, null).machines[1]?.reels[1];
		expect(reel && reelLabel(reel)).toBe("Audit: Needs attention");
		const bulbs = marqueeBulbs("arch", 200, 68, 26);
		expect(bulbs).toHaveLength(26);
		for (const bulb of bulbs) {
			expect(bulb.x).toBeGreaterThanOrEqual(0);
			expect(bulb.x).toBeLessThanOrEqual(200);
			expect(bulb.y).toBeGreaterThanOrEqual(0);
			expect(bulb.y).toBeLessThanOrEqual(68);
		}
	});
});

describe("arcade interface", () => {
	test("renders the floor with machines, filter chips and the paytable", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(arcade(port));
		expect(html).toContain('data-testid="interface-arcade"');
		expect(html).toContain('data-arcade-machine="agent-ada"');
		expect(html).not.toContain('data-arcade-machine="house"');
		expect(html).toContain('data-arcade-wall="project-site"');
		expect(html).toContain('aria-label="Paytable"');
		// Ada's fresh reply lights her topper; Grace tilts but has no topper.
		expect(html).toMatch(/data-arcade-machine="agent-ada"[^>]*data-hot=""/);
		expect(html).toContain("JACKPOT");
		expect(html).toContain("TILT");
		expect(html).not.toMatch(/data-arcade-machine="agent-grace"[^>]*data-hot/);
		// Grace has a live run, so her reels spin.
		expect(html).toMatch(
			/data-arcade-machine="agent-grace"[^>]*data-spinning=""/
		);
		// Only the working reel spins: Grace's TILT flame stays on the window.
		expect(html.match(/data-arcade-spin=""/g)).toHaveLength(1);
	});

	test("any reply waiting on you lights the topper, steady when it is old", () => {
		const { port } = recordingPort();
		const stale: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				...SNAPSHOT.threads,
				thread({
					agentIds: ["agent-ada"],
					id: "thread-newest",
					lastMessageRole: "user",
					title: "Newest",
					updatedAt: ago(1),
				}),
			],
		};
		const html = renderToStaticMarkup(arcade(port, { snapshot: stale }));
		// Ada's newest reel waits on the agent, so the topper holds steady.
		expect(html).not.toMatch(/data-arcade-machine="agent-ada"[^>]*data-hot/);
		expect(html).toMatch(/data-arcade-machine="agent-ada"[^>]*data-jackpot=""/);
		expect(html).toContain("JACKPOT");
	});

	test("rerenders never leave a conflicting animation style", async () => {
		const { port } = recordingPort();
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () => root.render(arcade(port)));
			// JACKPOT -> IN PLAY -> JACKPOT on Ada's machine.
			await act(async () =>
				root.render(
					arcade(port, {
						activeThreadId: "thread-palette",
						threadView: <div>Host chat</div>,
					})
				)
			);
			await act(async () => root.render(arcade(port)));
			await act(async () => root.unmount());
			container.remove();
		} finally {
			console.error = original;
		}
		expect(errors.filter((line) => line.includes("conflicting"))).toEqual([]);
	});

	test("loading shows skeletons, not machines", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(arcade(port, { loading: true }));
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("data-arcade-machine=");
		expect(html).toContain('data-slot="skeleton"');
		// The marquee keeps its place while loading, so nothing jumps.
		expect(html).toContain('aria-label="Marquee"');
	});

	test("an empty workspace explains the floor and offers a new game", async () => {
		const { port } = recordingPort();
		const view = await mount(
			arcade(port, {
				snapshot: { ...SNAPSHOT, agents: [], groups: [], threads: [] },
			})
		);
		expect(view.container.textContent).toContain("The floor is empty");
		const newGames = [...view.container.querySelectorAll("button")].filter(
			(button) => button.textContent?.trim() === "New game"
		);
		await click(newGames.at(-1));
		expect(
			view.container.querySelector("[data-arcade-composer]")
		).not.toBeNull();
		await view.dispose();
	});

	test("cashing a ticket or a reel opens the thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		await click(byLabel(view.container, "Cash ticket: open Pick a palette"));
		await click(
			byLabel(view.container, "Open Release notes: Waiting on agent")
		);
		await click(byLabel(view.container, "Collect: open Pick a palette"));
		expect(calls).toEqual([
			"open:thread-palette",
			"open:thread-notes",
			"open:thread-palette",
		]);
		await view.dispose();
	});

	test("the HUD collects the reply that has waited longest", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		await click(
			byLabel(
				view.container,
				"Collect jackpot: open Older reply (2 waiting on you)"
			)
		);
		expect(calls).toEqual(["open:thread-old"]);
		await view.dispose();
	});

	test("New game opens a play slip for any agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		await click(byLabel(view.container, "New game"));
		expect(
			view.container
				.querySelector("[data-arcade-composer]")
				?.getAttribute("aria-label")
		).toBeTruthy();
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("Spin opens a play slip that sends only what was typed", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		await click(byLabel(view.container, "Spin: message Ada"));
		const slip = view.container.querySelector("[data-arcade-composer]");
		expect(slip?.getAttribute("aria-label")).toBe("Play Ada");
		expect(
			view.container
				.querySelector('[data-arcade-machine="agent-ada"]')
				?.hasAttribute("data-composing")
		).toBe(true);
		// Opening the slip sends nothing.
		expect(calls).toEqual([]);
		const field = slip?.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the composer field");
		}
		await typeInto(field, "  Try a darker palette  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-ada","prompt":"Try a darker palette"}',
		]);
		expect(view.container.querySelector("[data-arcade-composer]")).toBeNull();
		// The machine spins as feedback.
		expect(
			view.container
				.querySelector('[data-arcade-machine="agent-ada"]')
				?.hasAttribute("data-spinning")
		).toBe(true);
		await view.dispose();
	});

	test("a filter chip narrows the floor and Escape steps back", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		const wall = view.container.querySelector('[data-arcade-wall="team-docs"]');
		await click(wall);
		expect(wall?.getAttribute("aria-pressed")).toBe("true");
		const machines = [
			...view.container.querySelectorAll("[data-arcade-machine]"),
		].map((element) => element.getAttribute("data-arcade-machine"));
		expect(machines).toEqual(["agent-linus"]);
		expect(view.container.querySelector("h1")?.textContent).toBe("Docs Crew");
		// A lever pulled while filtered files the thread under the team.
		await click(byLabel(view.container, "Spin: message Linus"));
		const root = view.container.querySelector(
			'[data-testid="interface-arcade"]'
		);
		if (!root) {
			throw new Error("Expected the arcade root");
		}
		await press(root, "Escape");
		expect(view.container.querySelector("[data-arcade-composer]")).toBeNull();
		await press(root, "Escape");
		expect(
			view.container.querySelectorAll("[data-arcade-machine]").length
		).toBe(3);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("a host page over the arcade keeps its Escape", async () => {
		const view = await mount(arcade(recordingPort().port));
		await click(view.container.querySelector('[data-arcade-wall="team-docs"]'));
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the arcade it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		expect(
			view.container.querySelectorAll("[data-arcade-machine]").length
		).toBe(1);
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(
			view.container.querySelectorAll("[data-arcade-machine]").length
		).toBe(3);
		await view.dispose();
	});

	test("an open thread shows the host view at the redemption counter", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			arcade(port, {
				activeThreadId: "thread-palette",
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = view.container.querySelector('[data-testid="arcade-panel"]');
		expect(panel?.textContent).toContain("Pick a palette");
		expect(panel?.textContent).toContain("Ada machine");
		expect(panel?.textContent).toContain("6 credits");
		expect(panel?.textContent).toContain("40m ago");
		expect(panel?.textContent).not.toContain("No.");
		expect(panel?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		// The ticket it came from is marked current in the tray.
		expect(
			byLabel(view.container, "Cash ticket: open Pick a palette")?.getAttribute(
				"aria-current"
			)
		).toBe("true");
		await click(byLabel(view.container, "Close ticket"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("only the machine a ticket was cashed from is in play", async () => {
		const { port } = recordingPort();
		const shared: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) =>
				item.id === "thread-palette"
					? { ...item, agentIds: ["agent-ada", "agent-linus"] }
					: item
			),
		};
		const view = await mount(
			arcade(port, {
				activeThreadId: "thread-palette",
				snapshot: shared,
				threadView: <div>Host chat</div>,
			})
		);
		const inPlay = () =>
			[
				...view.container.querySelectorAll(
					"[data-arcade-machine][data-active]"
				),
			].map((element) => element.getAttribute("data-arcade-machine"));
		expect(inPlay()).toEqual(["agent-ada"]);
		expect(view.container.textContent).toContain("IN PLAY");
		// A ticket in each member's tray, each naming the other.
		const tickets = [...view.container.querySelectorAll("button")].filter(
			(button) =>
				button.getAttribute("aria-label")?.startsWith("Cash ticket: open Pick")
		);
		expect(tickets.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Cash ticket: open Pick a palette, with Linus",
			"Cash ticket: open Pick a palette, with Ada",
		]);
		// Open it from Linus's reel: Linus is now the one in play.
		const linusReel = view.container
			.querySelector('[data-arcade-machine="agent-linus"]')
			?.querySelector('button[aria-label="Open Pick a palette: Your turn"]');
		await click(linusReel);
		expect(inPlay()).toEqual(["agent-linus"]);
		const current = view.container.querySelectorAll('[aria-current="true"]');
		for (const element of current) {
			expect(
				element
					.closest("[data-arcade-machine]")
					?.getAttribute("data-arcade-machine")
			).toBe("agent-linus");
		}
		await view.dispose();
	});

	test("pulling the lever opens the play slip at once", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(arcade(port));
		await click(byLabel(view.container, "Pull lever: message Linus"));
		expect(
			view.container
				.querySelector("[data-arcade-composer]")
				?.getAttribute("aria-label")
		).toBe("Play Linus");
		// The paytable steps aside for the slip.
		expect(view.container.querySelector('[aria-label="Paytable"]')).toBeNull();
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("each machine is one tab stop; arrow keys move inside it", async () => {
		const { port } = recordingPort();
		const view = await mount(arcade(port));
		const ada = view.container.querySelector(
			'[data-arcade-machine="agent-ada"]'
		);
		if (!ada) {
			throw new Error("Expected Ada's machine");
		}
		const tabbable = () =>
			[...ada.querySelectorAll<HTMLElement>("[data-arcade-stop]")]
				.filter((element) => element.tabIndex === 0)
				.map((element) => element.dataset.arcadeStop);
		expect(tabbable()).toEqual(["lever"]);
		const lever = byLabel(view.container, "Pull lever: message Ada");
		if (!lever) {
			throw new Error("Expected the lever");
		}
		await act(async () => lever.focus());
		// Past the lever (the last control), the arrow wraps to the first reel.
		await press(lever, "ArrowRight");
		expect(
			(document.activeElement as HTMLElement | null)?.dataset.arcadeStop
		).toBe("reel-0");
		expect(tabbable()).toEqual(["reel-0"]);
		await press(document.activeElement as Element, "End");
		expect(
			(document.activeElement as HTMLElement | null)?.dataset.arcadeStop
		).toBe("lever");
		await view.dispose();
	});
});

describe("arcade settings", () => {
	const meters = (container: HTMLElement) =>
		container.querySelector('section[aria-label="Meters"]');
	const mode = (container: HTMLElement) =>
		container.querySelector<HTMLElement>("[data-arcade-mode]")?.dataset
			.arcadeMode;

	test("hall lights follow the theme by default, or are set day or night", () => {
		expect(arcadeLights("theme", "light")).toBe("light");
		expect(arcadeLights("theme", "dark")).toBe("dark");
		expect(arcadeLights("day", "dark")).toBe("light");
		expect(arcadeLights("night", "light")).toBe("dark");
	});

	test("defaults show the meters under the theme's lights; overrides and live changes apply", async () => {
		const { port } = recordingPort();
		const view = await mount(arcade(port));
		expect(meters(view.container)).not.toBeNull();
		expect(mode(view.container)).toBe("light");
		await view.dispose();

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(arcade(port, { params: { lights: "night", meters: false } }))
		);
		expect(meters(container)).toBeNull();
		expect(mode(container)).toBe("dark");
		// A live change from Settings applies without a remount.
		await act(async () =>
			root.render(arcade(port, { params: { lights: "day", meters: true } }))
		);
		expect(meters(container)).not.toBeNull();
		expect(mode(container)).toBe("light");
		await act(async () => root.unmount());
		container.remove();
	});
});
