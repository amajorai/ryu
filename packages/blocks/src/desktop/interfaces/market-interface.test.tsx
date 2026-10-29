// The DOM first, before React loads (a side-effect import stays first).
import "./market-test-dom.ts";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	agentActs,
	resolveInterfaceParams,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	FIXTURE_PRIVATE_STRINGS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { limitWords } from "./game3d-act-stage.tsx";
import { stageAgents, youSpotSlots } from "./game3d-acts.ts";
import { ISO_ANGLE } from "./game3d-stage.tsx";
import {
	actKeepers,
	actOrderStatuses,
	actShops,
	chalkedLimit,
	type KeeperStation,
	keeperLayout,
	keeperStations,
	keeperWords,
	MARKET_TOOLS,
	marketActPaths,
	marketCross,
	marketShownOverlays,
	RING,
	shopNeedYou,
	shopSign,
	upcomingRuns,
	worksLive,
	youPoints,
} from "./market-acts.tsx";
import { keeperPose } from "./market-diorama.tsx";
import { MarketInterface, marketSettings } from "./market-interface.tsx";
import {
	ACT_KEEPER_SPACING_NARROW,
	buildMarket,
	GENERAL_STORE_ID,
	layoutMarket,
	type MarketShop,
	marketTotals,
	newOrderInput,
	orderRecipients,
	shopForThread,
	shopLabel,
	shopStyle,
	type Vec3,
	visitingFrom,
} from "./market-model.ts";
import { MARKET_3D, MARKET_3D_NIGHT, marketArt } from "./market-palette.ts";
import { MarketPanel } from "./market-panel.tsx";
import { ActClockProvider } from "./use-acts.ts";

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
		{
			avatarUrl: null,
			description: "On their own",
			id: "agent-solo",
			name: "Solo",
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
			memberAgentIds: ["agent-linus", "agent-grace"],
			name: "Docs Crew",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-palette",
			lastMessage: "Three palettes are ready.",
			projectId: "project-site",
			title: "Pick a palette",
			updatedAt: ago(40),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-hero",
			lastMessage: "Rebuilding the hero.",
			projectId: "project-site",
			running: true,
			teamId: "team-docs",
			title: "Landing hero",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-audit",
			lastMessage: "The run stopped.",
			projectId: "project-site",
			runState: "failed",
			title: "Audit",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-notes",
			lastMessage: "Can you shorten it?",
			lastMessageRole: "user",
			teamId: "team-docs",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-solo"],
			id: "thread-loose",
			lastMessage: "Done.",
			title: "",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

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

function market(
	overrides: Partial<Parameters<typeof MarketInterface>[0]> = {}
) {
	const { port } = recordingPort();
	return (
		<MarketInterface
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

describe("market model", () => {
	test("a project is a shop, a team a stall, the rest the general store", () => {
		const shops = buildMarket(SNAPSHOT);
		expect(shops.map((shop) => [shop.id, shop.kind])).toEqual([
			["project-site", "shop"],
			["team-docs", "stall"],
			[GENERAL_STORE_ID, "general"],
		]);
		const [site, docs, general] = shops;
		// A thread filed under both a project and a team is the project's order.
		expect(site?.orders.map((order) => order.thread.id)).toEqual([
			"thread-audit",
			"thread-palette",
			"thread-hero",
		]);
		expect(docs?.orders.map((order) => order.thread.id)).toEqual([
			"thread-notes",
		]);
		expect(general?.agents.map((agent) => agent.name)).toEqual(["Solo"]);
		expect(general?.orders.map((order) => order.thread.id)).toEqual([
			"thread-loose",
		]);
	});

	test("busy, waiting and slip numbers follow the orders", () => {
		const [site, docs, general] = buildMarket(SNAPSHOT);
		expect(site?.busy).toBe(true);
		expect(site?.waitingOnYou).toBe(2);
		// Slips are numbered oldest first, whatever order the board shows.
		expect(
			site?.orders.map((order) => [order.thread.id, order.number])
		).toEqual([
			["thread-audit", 1],
			["thread-palette", 2],
			["thread-hero", 3],
		]);
		// Grace works at the stall too, so it is busy without a live order.
		expect(docs?.busy).toBe(true);
		expect(docs?.waitingOnYou).toBe(0);
		expect(general?.busy).toBe(false);
		expect(marketTotals(buildMarket(SNAPSHOT))).toEqual({
			busy: 2,
			orders: 5,
			shops: 3,
			waitingOnYou: 3,
		});
	});

	test("facades are deterministic per id and differ across ids", () => {
		expect(shopStyle("project-site")).toEqual(shopStyle("project-site"));
		const styles = ["a", "b", "c", "d", "e", "f"].map((id) =>
			JSON.stringify(shopStyle(`project-${id}`))
		);
		expect(new Set(styles).size).toBeGreaterThan(1);
	});

	test("no general store when every agent and thread has a home", () => {
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			agents: SNAPSHOT.agents.filter((agent) => agent.id !== "agent-solo"),
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-loose"),
		};
		expect(buildMarket(snapshot).map((shop) => shop.kind)).toEqual([
			"shop",
			"stall",
		]);
		expect(
			buildMarket({ ...SNAPSHOT, agents: [], groups: [], threads: [] })
		).toEqual([]);
	});

	test("new orders go to the shopkeeper and file under the shop's group", () => {
		const [site, docs, general] = buildMarket(SNAPSHOT);
		if (!(site && docs && general)) {
			throw new Error("Expected three shops");
		}
		expect(newOrderInput(site, "agent-ada", "Hi")).toEqual({
			agentId: "agent-ada",
			projectId: "project-site",
			prompt: "Hi",
		});
		expect(newOrderInput(docs, undefined, "Hi")).toEqual({
			prompt: "Hi",
			teamId: "team-docs",
		});
		expect(newOrderInput(general, "agent-solo", "Hi")).toEqual({
			agentId: "agent-solo",
			prompt: "Hi",
		});
		expect(orderRecipients(site, SNAPSHOT).map((agent) => agent.id)).toEqual([
			"agent-ada",
			"agent-grace",
		]);
		// The general store can take an order for anyone, its own keepers first.
		expect(orderRecipients(general, SNAPSHOT).map((agent) => agent.id)).toEqual(
			["agent-solo", "agent-ada", "agent-grace", "agent-linus"]
		);
		expect(shopForThread(buildMarket(SNAPSHOT), "thread-notes")?.id).toBe(
			"team-docs"
		);
		expect(shopForThread(buildMarket(SNAPSHOT), null)).toBeUndefined();
	});

	test("the square puts the back row facing the viewer, the rest facing right", () => {
		const shops = buildMarket(SNAPSHOT);
		const square = layoutMarket(shops);
		expect(square.lots.map((lot) => [lot.shop.id, lot.facing])).toEqual([
			["project-site", "south"],
			["team-docs", "south"],
			[GENERAL_STORE_ID, "east"],
		]);
		// Centred on the origin, with the square inside the bounds.
		const { bounds } = square;
		expect(bounds.minX + bounds.maxX).toBeCloseTo(0, 5);
		expect(bounds.minZ + bounds.maxZ).toBeCloseTo(0, 5);
		expect(square.square.minX).toBeGreaterThan(bounds.minX);
		expect(square.square.maxZ).toBeLessThan(bounds.maxZ);
		// The back row's signs run left to right; the left row's toward the viewer.
		const [site, docs, general] = square.lots;
		expect((site?.sign[0] ?? 0) < (docs?.sign[0] ?? 0)).toBe(true);
		expect((general?.sign[0] ?? 0) < (site?.sign[0] ?? 0)).toBe(true);
	});

	test("keepers stand out front and the queue counts what waits on you", () => {
		const [site, docs, general] = layoutMarket(buildMarket(SNAPSHOT)).lots;
		expect(site?.keepers).toHaveLength(2);
		expect(site?.queue).toHaveLength(2);
		expect(docs?.keepers).toHaveLength(2);
		expect(docs?.queue).toHaveLength(0);
		expect(general?.keepers).toHaveLength(1);
		expect(general?.queue).toHaveLength(1);
		// Nobody in a queue stands on a shopkeeper's toes.
		for (const lot of [site, docs, general]) {
			for (const customer of lot?.queue ?? []) {
				for (const keeper of lot?.keepers ?? []) {
					const apart = Math.hypot(
						customer[0] - keeper[0],
						customer[2] - keeper[2]
					);
					expect(apart).toBeGreaterThan(0.8);
				}
			}
		}
	});

	test("more shops grow both rows without lots overlapping", () => {
		const groups = Array.from({ length: 7 }, (_, index) => ({
			id: `project-${index}`,
			kind: "project" as const,
			memberAgentIds: [],
			name: `Project ${index}`,
		}));
		const square = layoutMarket(
			buildMarket({ ...SNAPSHOT, agents: [], groups, threads: [] })
		);
		expect(square.lots.filter((lot) => lot.facing === "south")).toHaveLength(4);
		expect(square.lots.filter((lot) => lot.facing === "east")).toHaveLength(3);
		const signs = square.lots.map((lot) => lot.sign);
		for (const [index, sign] of signs.entries()) {
			for (const other of signs.slice(index + 1)) {
				expect(
					Math.hypot(sign[0] - other[0], sign[2] - other[2])
				).toBeGreaterThan(3);
			}
		}
	});

	test("a shopkeeper's pose follows their own orders", () => {
		const [site, docs] = buildMarket(SNAPSHOT);
		if (!(site && docs)) {
			throw new Error("Expected a shop and a stall");
		}
		expect(keeperPose(site, "agent-grace")).toBe("failed");
		expect(keeperPose(site, "agent-ada")).toBe("needs-you");
		expect(keeperPose(docs, "agent-linus")).toBe("waiting");
		expect(keeperPose(docs, "agent-grace")).toBe("working");
	});

	test("general store slips say where a visiting agent works", () => {
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				...SNAPSHOT.threads,
				thread({ agentIds: ["agent-linus"], id: "thread-visit" }),
			],
		};
		const general = buildMarket(snapshot).find(
			(shop) => shop.id === GENERAL_STORE_ID
		);
		if (!general) {
			throw new Error("Expected the general store");
		}
		const homes = general.orders.map((order) =>
			visitingFrom(order, general, snapshot)
		);
		expect([...homes].sort()).toEqual(["Docs Crew", null]);
		const [site] = buildMarket(snapshot);
		const own = site?.orders[0];
		if (!(site && own)) {
			throw new Error("Expected a shop order");
		}
		expect(visitingFrom(own, site, snapshot)).toBe(null);
	});
});

describe("MarketInterface", () => {
	test("renders a shop button per project, team and the general store", () => {
		const markup = renderToStaticMarkup(market());
		expect(markup).toContain('data-testid="interface-market"');
		expect(markup).toContain("Market Street");
		const [site] = buildMarket(SNAPSHOT);
		if (!site) {
			throw new Error("Expected a shop");
		}
		expect(shopLabel(site)).toBe(
			"Website, Project shop, busy, 3 orders, 2 waiting on you"
		);
		expect(markup).toContain(`aria-label="${shopLabel(site)}"`);
		expect(markup.match(/data-testid="market-shop"/g)).toHaveLength(3);
		expect(markup).toContain("3 waiting on you");
		expect(markup).toContain("Place an order with Grace at Docs Crew");
	});

	test("renders loading and empty states", () => {
		const loading = renderToStaticMarkup(market({ loading: true }));
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).not.toContain('data-testid="market-shop"');

		const empty = renderToStaticMarkup(
			market({ snapshot: { ...SNAPSHOT, agents: [], groups: [], threads: [] } })
		);
		expect(empty).toContain("No shops on this street yet");
		expect(empty).toContain("Start a conversation");
		expect(empty).not.toContain('data-testid="market-shop"');
		expect(empty).not.toContain("Directory");
	});

	test("a shop opens its sheet with keepers and order slips; Serve opens", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(market({ port }));
		const [site] = buildMarket(SNAPSHOT);
		if (!site) {
			throw new Error("Expected a shop");
		}
		await click(byLabel(view.container, shopLabel(site)));
		const panel = view.container.querySelector('[data-testid="market-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("shop");
		expect(panel?.querySelector("h2")?.textContent).toBe("Website");
		expect(
			[...view.container.querySelectorAll('[data-testid="market-keeper"]')].map(
				(plate) => plate.getAttribute("aria-label")
			)
		).toEqual(["New order for Ada, idle", "New order for Grace, working"]);
		const slips = [
			...view.container.querySelectorAll('[data-testid="market-slip"]'),
		];
		expect(slips.map((slip) => slip.getAttribute("data-status"))).toEqual([
			"attention",
			"your-turn",
			"working",
		]);
		expect(slips[0]?.getAttribute("aria-label")).toBe("No. 01: Audit");
		expect(slips[0]?.textContent).toContain("No.01");

		await click(byLabel(view.container, "Serve No. 02: Pick a palette"));
		expect(calls).toEqual(["open:thread-palette"]);
		await view.dispose();
	});

	test("a new order goes to the picked shopkeeper at that shop", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(market({ port }));
		// A shopkeeper opens their shop with the order addressed to them.
		await click(
			byLabel(view.container, "Place an order with Grace at Docs Crew")
		);
		const panel = view.container.querySelector('[data-testid="market-panel"]');
		expect(panel?.querySelector("h2")?.textContent).toBe("Docs Crew");
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		const picker = view.container.querySelector("select");
		expect(picker?.value).toBe("agent-grace");
		await typeInto(field, "   ");
		await press(field, "Enter");
		expect(calls).toEqual([]);
		await typeInto(field, "  Draft the changelog  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"prompt":"Draft the changelog","agentId":"agent-grace","teamId":"team-docs"}',
		]);
		// Picking another keeper in the sheet readdresses the composer.
		await click(byLabel(view.container, "New order for Linus, idle"));
		expect(view.container.querySelector("select")?.value).toBe("agent-linus");
		await view.dispose();
	});

	test("an open thread shows the host view, with a way back to its shop", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			market({
				activeThreadId: "thread-notes",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = view.container.querySelector('[data-testid="market-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("thread");
		expect(panel?.textContent).toContain("Host chat");
		expect(panel?.textContent).toContain("Release notes");
		expect(panel?.textContent).toContain("No. 01 · Docs Crew");
		await click(byLabel(view.container, "Back to Docs Crew"));
		expect(calls).toEqual(["close"]);
		await click(byLabel(view.container, "Close order"));
		expect(calls).toEqual(["close", "close"]);
		await view.dispose();
	});

	test("the shop's sheet marks the slip being served", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			market({ activeThreadId: "thread-notes", port, threadView: null })
		);
		const docs = buildMarket(SNAPSHOT)[1];
		if (!docs) {
			throw new Error("Expected a stall");
		}
		await click(byLabel(view.container, shopLabel(docs)));
		await click(byLabel(view.container, "Serve No. 01: Release notes"));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.dispose();
	});

	test("Escape steps back out: the order, then the shop", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(market({ port }));
		const [site] = buildMarket(SNAPSHOT);
		if (!site) {
			throw new Error("Expected a shop");
		}
		await click(byLabel(view.container, shopLabel(site)));
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		// A draft keeps Escape for itself.
		await typeInto(field, "Half a thought");
		await press(field, "Escape");
		expect(
			view.container.querySelector('[data-testid="market-panel"]')
		).not.toBe(null);
		await typeInto(field, "");
		await press(field, "Escape");
		expect(view.container.querySelector('[data-testid="market-panel"]')).toBe(
			null
		);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("orders are pinned under what they need", async () => {
		const view = await mount(market());
		const [site] = buildMarket(SNAPSHOT);
		if (!site) {
			throw new Error("Expected a shop");
		}
		await click(byLabel(view.container, shopLabel(site)));
		const board = view.container.querySelector('[data-testid="market-board"]');
		const sections = [...(board?.querySelectorAll("section") ?? [])].map(
			(section) => section.getAttribute("aria-label")
		);
		expect(sections).toEqual([
			"Needs attention, 1 order",
			"Your turn, 1 order",
			"Working, 1 order",
		]);
		await view.dispose();
	});
});

describe("Market useful state", () => {
	const fixturePort = () => {
		const calls: string[] = [];
		const port: InterfacePort = {
			answerAsk: async (askId, choiceId) => {
				calls.push(`answer:${askId}:${choiceId}`);
			},
			closeThread: () => calls.push("close"),
			openInbox: () => calls.push("inbox"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: () => calls.push("start"),
		};
		return { calls, port };
	};
	const onFixture = (
		snapshot: InterfaceSnapshot = usefulStateFixture(),
		port: InterfacePort = fixturePort().port
	) => (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{market({ port, snapshot })}
		</ActClockProvider>
	);
	/** The keeper row for an agent in the fallback list (its home shop). */
	const row = (container: HTMLElement, name: string) => {
		const id = Object.entries(FIXTURE_AGENT_IDS).find(
			([key]) => key === name.toLowerCase()
		)?.[1];
		return container
			.querySelector(`[data-testid="market-list"] [data-act-agent="${id}"]`)
			?.closest("li");
	};
	/** Clicks like a user: the card opens after the click has finished. */
	const press = async (element: Element | null | undefined) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Expected a clickable element");
		}
		act(() => element.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
	};
	const button = (scope: Element | null | undefined, text: string) =>
		[...(scope?.querySelectorAll("button") ?? [])].filter(
			(candidate) => candidate.textContent === text
		);

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(onFixture());
			expect(view.container.textContent).toContain("Market Street");
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const view = await mount(onFixture());
		const ada = view.container.querySelector(
			`[data-testid="market-list"] [data-act-agent="${FIXTURE_AGENT_IDS.ada}"]`
		);
		const describedBy = ada?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		// Every agent has exactly one described row (its home shop).
		expect(
			view.container.querySelectorAll(
				'[data-testid="market-list"] [data-act-agent]'
			)
		).toHaveLength(10);
		await view.dispose();
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		await press(button(row(view.container, "Ada"), "Answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
	});

	test("a host page over the market keeps its Escape key", async () => {
		const view = await mount(market());
		const [site] = buildMarket(SNAPSHOT);
		if (!site) {
			throw new Error("Expected a shop");
		}
		await click(byLabel(view.container, shopLabel(site)));
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the market it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		const covered = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Escape",
		});
		await act(async () => {
			document.body.dispatchEvent(covered);
		});
		expect(covered.defaultPrevented).toBe(false);
		expect(
			view.container.querySelector('[data-testid="market-panel"]')
		).not.toBe(null);
		view.container.removeAttribute("inert");
		// Uncovered again, the same key closes the panel. (This describe's
		// \`press\` clicks, so the key is dispatched directly.)
		await act(async () => {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					key: "Escape",
				})
			);
		});
		expect(view.container.querySelector('[data-testid="market-panel"]')).toBe(
			null
		);
		await view.dispose();
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const view = await mount(onFixture());
		const details = button(row(view.container, "Di"), "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup");
		await view.dispose();
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const view = await mount(onFixture());
		await press(button(row(view.container, "Gu"), "Open answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await view.dispose();
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const view = await mount(onFixture());
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		await view.dispose();
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const view = await mount(onFixture());
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const view = await mount(onFixture());
		const items = [
			...view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(items).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		await view.dispose();
	});

	test("without asks the agent rows and counters are unchanged", () => {
		const { asks: _asks, ...old } = usefulStateFixture();
		const markup = renderToStaticMarkup(onFixture(old));
		expect(markup).not.toContain("data-act-agent");
		expect(markup).not.toContain("data-act-status");
		expect(markup).not.toContain("data-ask-queue");
		expect(markup).toContain("waiting on you");
		expect(markup).toContain("Place an order with Ada at Marketing site");
		// The renderer as it was before the act layer (market-legacy.golden.html,
		// rendered from the commit before it), on the old snapshot.
		const port = {
			closeThread: () => undefined,
			openThread: () => undefined,
			startThread: () => undefined,
		};
		const before = renderToStaticMarkup(
			<MarketInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={old as InterfaceSnapshot}
				threadView={null}
			/>
		).replace(/_[rR]_[0-9a-zA-Z]+_/g, "ID");
		// The kit's own stage attributes (data-iso-*, e.g. its fit state) are
		// normalised away like ids, so the golden pins the game's markup.
		const kitFree = (markup: string) =>
			markup.replace(/ data-iso-[a-z-]+="[^"]*"/g, "");
		expect(kitFree(before)).toBe(
			kitFree(
				readFileSync(join(import.meta.dir, "market-legacy.golden.html"), "utf8")
			)
		);
	});

	test("asks queue at the cross, and customers are upcoming runs", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const shops = actShops(buildMarket(snapshot), acts);
		const keepers = shops.flatMap((shop) => shop.agents.map((a) => a.id));
		expect([...keepers].sort()).toEqual(
			Object.values(FIXTURE_AGENT_IDS).sort()
		);
		const runs = upcomingRuns(shops, snapshot.events);
		const crew = shops.find((shop) => shop.name === "Core crew");
		expect(runs.get(crew?.id ?? "")?.map((event) => event.title)).toEqual([
			"Morning standup",
		]);
		const block = layoutMarket(shops, {
			queue: new Map([...runs].map(([id, list]) => [id, list.length])),
		});
		// Every keeper has a station; no shop queues the orders that need you.
		expect(keeperStations(block)).toHaveLength(10);
		expect(block.lots.map((lot) => lot.queue.length)).toEqual(
			block.lots.map((lot) => (lot.shop.id === crew?.id ? 1 : 0))
		);
		const paths = marketActPaths(block, keeperStations(block));
		for (const point of [
			"you",
			"you-1",
			"you-2",
			"you-3",
			"you-4",
			"you-tray",
		]) {
			expect(paths.points[point]).toBeDefined();
		}
		const slots = youSpotSlots(acts, unownedAsks(snapshot));
		expect(slots.slots.map((slot) => slot.ask.id)).toEqual([
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(shopNeedYou(shops, acts).get(GENERAL_STORE_ID)).toBe(1);
	});

	test("redacted: no thread titles or routine names on the street", () => {
		const markup = renderToStaticMarkup(
			onFixture(usefulStateFixture({ privacy: "redacted" }))
		);
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(markup).not.toContain(secret);
		}
	});

	test("keeper plates: Ada's answers her ask; Cy's keeps the order menu (15a)", async () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const shops = actShops(buildMarket(snapshot), acts);
		const block = layoutMarket(shops, { queue: new Map() });
		const stations = keeperStations(block);
		const opened: string[] = [];
		const cast = actKeepers({
			acts,
			looks: new Map(
				Object.values(FIXTURE_AGENT_IDS).map((id) => [id, {} as never])
			),
			nowMs: FIXTURE_NOW,
			onAsk: (askId) => opened.push(askId),
			paths: marketActPaths(block, stations),
			reduced: true,
			shown: new Set(),
			slots: youSpotSlots(acts, unownedAsks(snapshot)).slots,
			stations,
		});
		const ada = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.ada);
		expect(ada?.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		// `activate` replaces the menu: no aria-pressed, always a Tab stop.
		ada?.activate?.();
		expect(opened).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		// A queued keeper's plate keeps its words ("Ada · 14m") when narrow.
		expect(ada?.youSpot).toBe("slot");
		expect(ada?.iconOnly).toBe(false);
		const cy = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.cy);
		expect(cy?.activate).toBeUndefined();
		expect(cy?.label).toBe(
			`${acts.get(FIXTURE_AGENT_IDS.cy)?.ariaLabel} Place an order with Cy.`
		);
		// Rendered as the kit's plates (drei's Html is a plain wrapper here):
		// Ada's is a Tab stop without aria-pressed that opens her ask; Cy's
		// keeps aria-pressed and the street's onSelect, whose id names Cy's
		// shop and Cy (MarketDioramaScene opens the order composer from it).
		mock.module("@react-three/drei", () => ({
			Html: ({ children }: { children: ReactNode }) => children,
		}));
		try {
			const { VillagerPlate } = await import("./game3d-villager.tsx");
			const picked: string[] = [];
			const plate = async (spec: (typeof cast)[number] | undefined) => {
				if (!spec) {
					throw new Error("no plate");
				}
				const view = await mount(
					<VillagerPlate
						onSelect={(id) => picked.push(id)}
						selected={false}
						spec={spec}
					/>
				);
				const found = view.container.querySelector("button");
				if (!found) {
					throw new Error("no button");
				}
				return { button: found, view };
			};
			const adaPlate = await plate(ada);
			expect(adaPlate.button.hasAttribute("aria-pressed")).toBe(false);
			expect(adaPlate.button.getAttribute("tabindex")).toBe("0");
			await click(adaPlate.button);
			expect(opened).toEqual([
				FIXTURE_ASK_IDS.adaToolCall,
				FIXTURE_ASK_IDS.adaToolCall,
			]);
			expect(picked).toEqual([]);
			await adaPlate.view.dispose();
			const cyPlate = await plate(cy);
			expect(cyPlate.button.getAttribute("aria-pressed")).toBe("false");
			expect(cyPlate.button.getAttribute("tabindex")).toBe("0");
			await click(cyPlate.button);
			const cyShop = stations.find(
				(station) => station.agentId === FIXTURE_AGENT_IDS.cy
			)?.shopId;
			expect(picked).toEqual([`${cyShop}\n${FIXTURE_AGENT_IDS.cy}`]);
			await cyPlate.view.dispose();
		} finally {
			mock.restore();
		}
	});

	test("overlay budget: every exempt target stays, icon-only when narrow (21)", () => {
		// The very options and items MarketInterface passes (it calls
		// marketShownOverlays with its stage width and draws what it returns).
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(acts, unownedAsks(snapshot));
		const at = (width: number) =>
			marketShownOverlays({
				offStage,
				onStage,
				reduced: false,
				slots,
				width,
			});
		const wide = at(1280);
		const narrow = at(390);
		const ids = FIXTURE_AGENT_IDS;
		expect(wide.shown.size).toBeLessThanOrEqual(16);
		expect([...wide.shown].some((id) => id.startsWith("ask:"))).toBe(true);
		// Both working keepers' bubbles show on a wide stage…
		expect(wide.shown.has(`work:${ids.cy}`)).toBe(true);
		expect(wide.shown.has(`work:${ids.io}`)).toBe(true);
		expect(narrow.shown.size).toBeLessThanOrEqual(8);
		// …and on a phone no ask or work bubble does (the street runs down
		// the screen there; each keeper's board carries its step).
		expect(
			[...narrow.shown].filter(
				(id) => id.startsWith("ask:") || id.startsWith("work:")
			)
		).toEqual([]);
		// A phone keeps Fa's limit and Cy's station words.
		expect(
			[`limit:${ids.fa}`, `progress:${ids.cy}`, `next:${ids.cy}`].filter(
				(id) => !narrow.shown.has(id)
			)
		).toEqual([]);
		// The exempt targets themselves are rendered and checked in
		// market-scene.test.tsx (the act props and keeper plates at both widths).
		// Under reduced motion no work bubble is scripted, so none is budgeted.
		const still = marketShownOverlays({
			offStage,
			onStage,
			reduced: true,
			slots,
			width: 1280,
		});
		expect([...still.shown].filter((id) => id.startsWith("work:"))).toEqual([]);
	});

	test("board sections and door signs follow the acts", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const statuses = actOrderStatuses(snapshot, acts);
		const t = FIXTURE_THREAD_IDS;
		expect(
			[t.ada, t.bo, t.gu, t.cy, t.io, t.di, t.ed].map((id) => statuses.get(id))
		).toEqual([
			"your-turn",
			"your-turn",
			"your-turn",
			"working",
			"working",
			"attention",
			"attention",
		]);
		// Ha's 30 h old failure no longer needs attention.
		expect(statuses.get(t.haDigest)).toBe("quiet");
		// A read reply with no ask is not your turn, even under acts.
		expect([statuses.get(t.fa), statuses.get(t.ha)]).toEqual([
			"quiet",
			"quiet",
		]);
		// Every thread has a section: the acts' word where they speak to it,
		// else its own status.
		expect(snapshot.threads.every((item) => statuses.has(item.id))).toBe(true);
		// A keeper's other running thread (not the one its act shows) stays
		// working, not quiet.
		const extra = {
			...(snapshot.threads.find((item) => item.id === t.cy) ??
				snapshot.threads[0]),
			id: "t-cy-other",
			running: true,
			title: "Another job",
		} as InterfaceThread;
		const busier = { ...snapshot, threads: [...snapshot.threads, extra] };
		const busierActs = agentActs(busier, FIXTURE_NOW, FIXTURE_CLOCK);
		expect(busierActs.get(FIXTURE_AGENT_IDS.cy)?.threadId).toBe(t.cy);
		expect(actOrderStatuses(busier, busierActs).get("t-cy-other")).toBe(
			"working"
		);
		const shop = (ids: string[]) =>
			({
				agents: snapshot.agents.filter((agent) => ids.includes(agent.id)),
			}) as MarketShop;
		const a = FIXTURE_AGENT_IDS;
		expect(shopSign(shop([a.cy, a.fa]), acts)).toBe("Busy");
		expect(shopSign(shop([a.di]), acts)).toBe("Stopped");
		expect(shopSign(shop([a.fa]), acts)).toBe("Closed for now");
		expect(shopSign(shop([a.gu]), acts)).toBe("Open");
	});

	test("the limit is chalked in the market's words", () => {
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const fa = acts.get(FIXTURE_AGENT_IDS.fa);
		const words = (act: typeof fa) =>
			act &&
			limitWords(act, {
				clock: FIXTURE_CLOCK,
				limitText: chalkedLimit,
				nowMs: FIXTURE_NOW,
			});
		expect(words(fa)).toBe("Back 15:10");
		const guessed = fa && {
			...fa,
			blockers: [
				{
					kind: "rate-limited",
					source: "estimate",
				} as InterfaceAgentAct["blockers"][number],
			],
			timer: null,
		};
		expect(words(guessed)).toBe("Likely closed for now");
	});

	test("the sheet, directory and slips read the acts, not the orders", async () => {
		const view = await mount(onFixture());
		const general = view.container.querySelector(
			`[data-testid="market-list"] button[aria-label^="General store"]`
		);
		// Bo's ask is the only blocking ask at the general store.
		expect(general?.getAttribute("aria-label")).toContain("1 need you");
		expect(general?.getAttribute("aria-label")).not.toContain("waiting on you");
		await press(general);
		const panel = view.container.querySelector('[data-testid="market-panel"]');
		expect(panel?.textContent).toContain("1 need you");
		expect(panel?.textContent).not.toContain("waiting on you");
		expect(panel?.querySelector("time")).toBeNull();
		await view.dispose();
	});
	/** The fixture's act street, as MarketInterface lays it out. */
	const actStreet = (narrow = false) => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const shops = actShops(buildMarket(snapshot), acts);
		const runs = upcomingRuns(shops, snapshot.events);
		const block = layoutMarket(shops, {
			...(narrow
				? {
						eastSpacing: ACT_KEEPER_SPACING_NARROW,
						spacing: ACT_KEEPER_SPACING_NARROW,
					}
				: {}),
			queue: new Map([...runs].map(([id, list]) => [id, list.length])),
		});
		return { acts, block, snapshot, stations: keeperStations(block) };
	};
	/** World units up the screen at the 1280 camera (yaw 45, pitch 0.56). */
	const screenUp = ([x, y, z]: Vec3) =>
		-Math.sin(ISO_ANGLE.pitch) * Math.sin(ISO_ANGLE.yaw) * x +
		Math.cos(ISO_ANGLE.pitch) * y -
		Math.sin(ISO_ANGLE.pitch) * Math.cos(ISO_ANGLE.yaw) * z;
	const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

	test("the back row holds the most keepers; no keeper stands in the bubble lane of the one before (M1)", () => {
		const { block, stations } = actStreet();
		const south = block.lots.filter((lot) => lot.facing === "south");
		const east = block.lots.filter((lot) => lot.facing === "east");
		const most = (lots: typeof south) =>
			Math.max(0, ...lots.map((lot) => lot.keepers.length));
		expect(most(south)).toBeGreaterThanOrEqual(most(east));
		expect(south[0]?.shop.id).toBe(GENERAL_STORE_ID);
		// A work bubble hangs up and to the right of a plate, from 20 px to
		// 44 px over its middle. In the back row the next keeper (to the
		// right) stands lower on the screen, so it is never in that lane…
		const row = (facing: "east" | "south") =>
			stations
				.filter((station) => station.facing === facing)
				.sort((a, b) =>
					facing === "south" ? a.at[0] - b.at[0] : b.at[2] - a.at[2]
				);
		const back = row("south");
		for (const [index, station] of back.entries()) {
			const next = back[index + 1];
			if (next) {
				expect(screenUp(next.at)).toBeLessThan(screenUp(station.at));
			}
		}
		// …and in the left row the next keeper (up and to the right) stands
		// so far up that its feet clear the bubble's top: 44 px over the
		// plate, the plate 41 px over the feet, at the 1280 zoom's ~26 px a
		// unit (85 px ≈ 3.3 units).
		const left = row("east");
		for (const [index, station] of left.entries()) {
			const next = left[index + 1];
			if (next) {
				expect(screenUp(next.at) - screenUp(station.at)).toBeGreaterThan(3.3);
			}
		}
	});

	test("the queue at the cross stands clear of the fountain and every walk goes round it (M5)", () => {
		for (const narrow of [false, true]) {
			const { block, stations } = actStreet(narrow);
			const cross = marketCross(block);
			const points = youPoints(block, narrow);
			for (const id of [
				"you",
				"you-1",
				"you-2",
				"you-3",
				"you-4",
				"you-tray",
			]) {
				const point = points[id];
				expect(point && flat(point, cross)).toBeGreaterThan(RING);
			}
			// The basin is 1.05 across its rim; a villager is about half a
			// unit wide, so a walk keeps 1.3 from the fountain's middle.
			const paths = marketActPaths(block, stations, narrow);
			const clearance = (a: Vec3, b: Vec3) => {
				const dx = b[0] - a[0];
				const dz = b[2] - a[2];
				const length = dx * dx + dz * dz;
				const t =
					length === 0
						? 0
						: Math.max(
								0,
								Math.min(
									1,
									((cross[0] - a[0]) * dx + (cross[2] - a[2]) * dz) / length
								)
							);
				return flat([a[0] + t * dx, 0, a[2] + t * dz], cross);
			};
			for (const [from, to] of paths.links) {
				const a = paths.points[from];
				const b = paths.points[to];
				if (!(a && b)) {
					throw new Error(`missing ${from} or ${to}`);
				}
				expect(clearance(a, b)).toBeGreaterThan(1.3);
			}
			// The queue holds its places in a line (each to the next).
			expect(paths.links).toContainEqual(["you-1", "you-2"]);
			expect(paths.links).toContainEqual(["you-3", "you-4"]);
		}
	});

	test("customers (upcoming runs) line up beyond the outermost keeper (m4)", () => {
		const { block, stations } = actStreet();
		const customers = block.lots.flatMap((lot) => lot.queue);
		expect(customers.length).toBeGreaterThan(0);
		for (const lot of block.lots) {
			for (const customer of lot.queue) {
				// Past the lot's last keeper along its front.
				const along = (point: Vec3) =>
					lot.facing === "south" ? point[0] : -point[2];
				const away = lot.facing === "south" ? 1 : -1;
				for (const keeper of lot.keepers) {
					expect(away * (along(customer) - along(keeper))).toBeGreaterThan(1.5);
				}
			}
		}
		// Nobody in a queue stands on any keeper's toes or props.
		for (const customer of customers) {
			for (const station of stations) {
				const layout = keeperLayout(station);
				const at = (offset: Vec3): Vec3 => [
					station.at[0] + offset[0],
					0,
					station.at[2] + offset[2],
				];
				for (const point of [
					station.at,
					at(layout.pips),
					at(layout.board),
					at(layout.unread),
					at(layout.suggestion),
				]) {
					expect(flat(customer, point)).toBeGreaterThan(1);
				}
			}
		}
	});

	test("a keeper's props stay a plate apart, on both facings, at shops and stalls (m3)", () => {
		// A plate is 28 px tall; at the 1280 zoom (~26 px a world unit) that is
		// about 1.1 units on the ground, so props closer than that would
		// stack their plates on each other.
		const PLATE = 1.1;
		for (const facing of ["south", "east"] as const) {
			for (const stall of [false, true]) {
				const south = facing === "south";
				const station: KeeperStation = {
					agentId: "a",
					at: [0, 0, 0],
					facing,
					front: south ? [0, 0, 1] : [1, 0, 0],
					id: "keeper:a",
					last: false,
					shopId: "s",
					side: south ? [1, 0, 0] : [0, 0, -1],
					stall,
					stretch: 3,
					wall: 0.5,
				};
				for (const narrow of [false, true]) {
					const layout = keeperLayout(station, narrow);
					const props = [
						["alarms", layout.alarms],
						["unread", layout.unread],
						["suggestion", layout.suggestion],
						["limit", layout.limit],
						["board", layout.board],
					] as const;
					for (const [index, [name, point]] of props.entries()) {
						for (const [other, there] of props.slice(index + 1)) {
							const apart = flat(point, there);
							if (apart <= PLATE) {
								throw new Error(
									`${facing} ${stall ? "stall" : "shop"}${narrow ? " (narrow)" : ""}: ${name} and ${other} are ${apart.toFixed(2)} apart`
								);
							}
						}
					}
					// The alarms hang to the right, beside the figure: their anchor
					// sits off its screen column to the right, at the camera's yaw
					// (45 degrees wide, 65 on a phone).
					const yaw = narrow ? Math.PI / 4 + 0.35 : Math.PI / 4;
					const right = (point: Vec3) =>
						Math.cos(yaw) * point[0] - Math.sin(yaw) * point[2];
					expect(layout.alarmSide).toBe("right");
					expect(right(layout.alarms)).toBeGreaterThan(0.8);
				}
			}
		}
	});

	// Stacked alarm plates keep the stage's 8 px plate gap: a plate row is its
	// height plus 4 px, and the extra climb adds the rest at both zooms.
	test("stacked alarms climb a plate row and a gap, never parted by the stage (m3)", () => {
		const { stations } = actStreet();
		const di = stations.find((item) => item.agentId === FIXTURE_AGENT_IDS.di);
		if (!di) {
			throw new Error("no Di");
		}
		// Di is the back row's last keeper: her stack drops down the screen,
		// away from Cy's bubble; everyone else's climbs.
		expect(
			stations.filter((item) => item.last).map((item) => item.agentId)
		).toEqual([FIXTURE_AGENT_IDS.di]);
		for (const narrow of [false, true]) {
			const layout = keeperLayout(di, narrow);
			expect(layout.alarmRows).toBe(-1);
			expect(keeperLayout({ ...di, last: false }, narrow).alarmRows).toBe(1);
			// ~22 px a unit up the screen at 1280 and ~7.8 on a phone.
			// The extra climb runs the same way as the rows (down for Di).
			expect(Math.sign(layout.alarmStep[1])).toBe(layout.alarmRows ?? 1);
			const extra = Math.abs(layout.alarmStep[1]) * (narrow ? 7.8 : 22);
			expect(4 + extra).toBeGreaterThanOrEqual(8);
		}
	});

	test("keepers carry the kit's scale and ledger (m1)", () => {
		expect([
			MARKET_TOOLS.run,
			MARKET_TOOLS.tool,
			MARKET_TOOLS.delegate,
			MARKET_TOOLS.read,
			MARKET_TOOLS.think,
		]).toEqual(["scale", "scale", "scale", "ledger", "ledger"]);
	});

	test("the sheet's sign dot follows the sign and its chips use the act's words (m5)", async () => {
		const view = await mount(onFixture());
		const general = view.container.querySelector(
			`[data-testid="market-list"] button[aria-label^="General store"]`
		);
		await press(general);
		const chips = [
			...view.container.querySelectorAll('[data-testid="market-keeper"]'),
		].map((chip) => chip.getAttribute("aria-label"));
		expect(chips).toContain("New order for Ed, stopped");
		expect(chips).toContain("New order for Fa, closed for now");
		expect(chips).toContain("New order for Io, working");
		expect(chips).toContain("New order for Bo, asking you");
		expect(chips).not.toContain("New order for Ed, idle");
		await view.dispose();
		// A stopped shop's dot is the stopped colour, not "open" green.
		const [shop] = buildMarket(SNAPSHOT);
		if (!shop) {
			throw new Error("Expected a shop");
		}
		const sheet = (sign: string) =>
			renderToStaticMarkup(
				<MarketPanel
					activeThreadId={null}
					acts={{
						busy: () => sign === "Busy",
						keeper: () => ({ words: "stopped", working: false }),
						needYou: () => 0,
						sign: () => sign,
						statuses: new Map(),
					}}
					composerAgentId={null}
					headingRef={{ current: null }}
					now={BASE}
					onClose={() => undefined}
					onCloseOrder={() => undefined}
					onPickKeeper={() => undefined}
					onPlaceOrder={() => undefined}
					onServe={() => undefined}
					reduceMotion
					snapshot={SNAPSHOT}
					threadView={null}
					view={{ kind: "shop", shop }}
				/>
			);
		const dot = (markup: string) =>
			/class="size-2 rounded-full ([^"]+)"/.exec(markup)?.[1];
		expect(dot(sheet("Stopped"))).toBe("bg-(--gk-bad)");
		expect(dot(sheet("Open"))).toBe("bg-(--gk-good)");
		expect(dot(sheet("Closed for now"))).toBe("bg-(--gk-warn)");
		expect(sheet("Stopped")).toContain("New order for Ada, stopped");
	});
	test("a stalled keeper is never worded as live work (k1)", async () => {
		// Cy's run with no progress for 12 minutes: stalled (spec §7.1).
		const base = usefulStateFixture();
		const t = FIXTURE_THREAD_IDS;
		const snapshot: InterfaceSnapshot = {
			...base,
			threads: base.threads.map((item) =>
				item.id === t.cy
					? {
							...item,
							lastProgressAt: new Date(FIXTURE_NOW - 12 * MINUTE).toISOString(),
						}
					: item
			),
		};
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const cy = acts.get(FIXTURE_AGENT_IDS.cy);
		expect(cy?.act).toBe("working");
		expect(cy?.stalled).toBe(true);
		expect(worksLive(cy)).toBe(false);
		expect(keeperWords(cy)).toBe("may have stopped");
		// Its thread is not filed as working; it needs a look.
		expect(actOrderStatuses(snapshot, acts).get(t.cy)).toBe("attention");
		// A shop whose only working keeper is stalled is not "Busy".
		const shop = {
			agents: snapshot.agents.filter(
				(agent) => agent.id === FIXTURE_AGENT_IDS.cy
			),
		} as MarketShop;
		expect(shopSign(shop, acts)).not.toBe("Busy");
		// The sheet's chip says so, with no working dot.
		const view = await mount(onFixture(snapshot));
		const crew = view.container.querySelector(
			`[data-testid="market-list"] button[aria-label^="Core crew"]`
		);
		expect(crew?.getAttribute("aria-label")).not.toContain("busy");
		await press(crew);
		const chip = [
			...view.container.querySelectorAll('[data-testid="market-keeper"]'),
		].find((item) => item.getAttribute("aria-label")?.includes("Cy"));
		expect(chip?.getAttribute("aria-label")).toBe(
			"New order for Cy, may have stopped"
		);
		expect(chip?.querySelector(".bg-success")).toBeNull();
		await view.dispose();
		// The live fixture still reads Cy as working.
		const live = agentActs(base, FIXTURE_NOW, FIXTURE_CLOCK).get(
			FIXTURE_AGENT_IDS.cy
		);
		expect(keeperWords(live)).toBe("working");
	});
});

describe("Market settings", () => {
	test("default to mixed awnings and bunting, and fall back on junk", () => {
		expect(resolveInterfaceParams("market", {})).toMatchObject({
			awnings: "mixed",
			bunting: true,
		});
		expect(
			resolveInterfaceParams("market", { awnings: "neon", bunting: "yes" })
		).toMatchObject({ awnings: "mixed", bunting: true });
	});

	test("the street reads its params: awning presets and bunting", () => {
		expect(marketSettings(undefined)).toMatchObject({
			awnings: "mixed",
			bunting: true,
		});
		expect(
			marketSettings({ awnings: "seaside", bunting: false })
		).toMatchObject({ awnings: "seaside", bunting: false });
		// Mixed is the stock art itself, so the default street is unchanged.
		expect(marketArt(false)).toBe(MARKET_3D);
		expect(marketArt(true, "mixed")).toBe(MARKET_3D_NIGHT);
		const seaside = marketArt(false, "seaside");
		expect(seaside.awning).not.toEqual(MARKET_3D.awning);
		expect(seaside.awning).toHaveLength(MARKET_3D.awning.length);
		expect(seaside.wall).toBe(MARKET_3D.wall);
		expect(marketArt(true, "harvest").awning).not.toEqual(
			marketArt(false, "harvest").awning
		);
	});

	test("the street's own overlays honour work bubbles and overlay density", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(acts, unownedAsks(snapshot));
		const base = { offStage, onStage, reduced: false, slots, width: 1280 };
		const ids = FIXTURE_AGENT_IDS;
		expect(marketShownOverlays(base).shown.has(`work:${ids.cy}`)).toBe(true);
		const quiet = marketShownOverlays({
			...base,
			kit: { overlayDensity: "minimal", workBubbles: false },
		}).shown;
		expect(
			[...quiet].filter(
				(id) =>
					id.startsWith("work:") ||
					id.startsWith("progress:") ||
					id.startsWith("next:")
			)
		).toEqual([]);
		// Asks and limits always stay.
		expect([...quiet].some((id) => id.startsWith("ask:"))).toBe(true);
		expect(quiet.has(`limit:${ids.fa}`)).toBe(true);
	});
});
