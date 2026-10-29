import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, askAriaLabel, isWorldTileFree, layoutWorld } = await import(
	"@ryuhq/protocol/interfaces"
);
const { world2dActorTile, world2dYouSpot } = await import("./world-2d-acts.ts");
const { layoutVillage } = await import("./world-village.ts");
const { world2dActLine } = await import("./world-2d-panel.tsx");
const { youSpotSlots } = await import("./game3d-acts.ts");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { ActClockProvider } = await import("./use-acts.ts");
const { actorAct, World2dInterface } = await import("./world-2d-interface.tsx");

import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const mounted: (() => void)[] = [];
afterEach(() => {
	for (const dispose of mounted.splice(0)) {
		dispose();
	}
});

async function settle(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mount(element: ReactElement): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(element));
	mounted.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await settle();
	return container;
}

async function press(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a button");
	}
	act(() => element.click());
	await settle();
}

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

const fixture = usefulStateFixture();
const actsNow = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const agentId = (name: string): string => {
	const found = [...actsNow.values()].find((item) => item.agentName === name);
	if (!found) {
		throw new Error(`no agent ${name}`);
	}
	return found.agentId;
};

function world(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<World2dInterface
			activeThreadId={null}
			loading={false}
			params={{ theme: "meadow" }}
			port={port}
			snapshot={snapshot}
			threadView={null}
		/>
	);
	return acted ? (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{game}
		</ActClockProvider>
	) : (
		game
	);
}

describe("world-2d useful state (text equivalent)", () => {
	test("the act pieces sit beside the map, never inside role=application", async () => {
		const container = await mount(world(fixture));
		const map = container.querySelector('[role="application"]');
		for (const selector of [
			"[data-act-summary]",
			"[data-queue-button]",
			"[data-need-you]",
			"[data-act-agent-list]",
			"[data-act-announcer]",
		]) {
			const found = container.querySelector(selector);
			expect(found).not.toBeNull();
			expect(map?.contains(found ?? null)).toBe(false);
		}
		expect(container.querySelector("[data-act-summary]")?.textContent).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
	});

	test("the hotbar leads with the askers; their slots answer the ask", async () => {
		const container = await mount(world(fixture));
		const slots = [
			...container.querySelectorAll<HTMLElement>(
				'nav[aria-label="Villagers"] [data-act-agent]'
			),
		];
		expect(slots.length).toBeGreaterThan(2);
		// Bo, then Ada: the queue's order.
		expect(slots.slice(0, 2).map((slot) => slot.dataset.actAgent)).toEqual([
			agentId("Bo"),
			agentId("Ada"),
		]);
		for (const slot of slots) {
			const act = actsNow.get(slot.dataset.actAgent ?? "");
			const label = slot.getAttribute("aria-label") ?? "";
			if (act?.act === "asking" && act.ask) {
				expect(label).toBe(
					`${askAriaLabel(act.ask, act.agentName, FIXTURE_NOW, "full")} Answer their ask.`
				);
			} else {
				expect(label.startsWith(act?.ariaLabel ?? "?")).toBe(true);
			}
		}
		await press(slots[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Which DB to use?");
	});

	test("the talk box says the act, a stopped run's reason included", () => {
		const line = (name: string, privacy: "full" | "redacted" = "full") => {
			const found = actsNow.get(agentId(name));
			if (!found) {
				throw new Error(name);
			}
			return world2dActLine(found, fixture.threads, privacy);
		};
		expect(line("Di")).toBe(
			"My run stopped: Tests failed. Can you take a look?"
		);
		expect(line("Ed")).toBe("My run was interrupted.");
		expect(line("Cy")).toBe("Hang on: Editing snapshot.ts.");
		expect(line("Cy", "redacted")).toBe(
			"Hang on, I'm in the middle of something."
		);
		expect(line("Ha")).toBeNull();
		// A limit says when it is back, from the act's own words.
		const fa = actsNow.get(agentId("Fa"));
		const back = /back (.+)$/.exec(fa?.bubble?.text ?? "")?.[1];
		expect(line("Fa")).toBe(
			back
				? `I've hit my limit for now. I'll be back ${back}.`
				: "I've hit my limit for now."
		);
	});

	test("askers walk to your doorstep, deliverers by the chest", () => {
		const layout = layoutWorld(fixture);
		const village = layoutVillage(layout);
		const free = (point: { x: number; y: number }) =>
			isWorldTileFree(layout, point) &&
			!village.blocked.has(`${point.x},${point.y}`);
		const key = (point: { x: number; y: number }) => `${point.x},${point.y}`;
		for (const narrow of [false, true]) {
			const spot = world2dYouSpot(layout, free, narrow);
			const placed = [
				...Object.values(spot.slots),
				spot.tray,
				...spot.trayRow,
			].filter((place) => place !== null);
			// Four queue places, a chest and its row: all free, none shared,
			// none on you.
			expect(placed.length).toBeGreaterThan(5);
			for (const place of placed) {
				expect(free(place)).toBe(true);
				expect(place).not.toEqual(spot.you);
			}
			// No two queue places are side by side on a row or column, and none
			// stands just south of a home.
			const queue = Object.values(spot.slots).filter((place) => place !== null);
			for (const [index, place] of queue.entries()) {
				expect(
					layout.entities.some(
						(entity) => entity.x === place.x && entity.y === place.y - 1
					)
				).toBe(false);
				for (const other of queue.slice(index + 1)) {
					expect(
						Math.abs(place.x - other.x) + Math.abs(place.y - other.y)
					).toBeGreaterThan(1);
				}
			}
			// Deliverers leave a tile of room round you.
			for (const place of spot.trayRow) {
				expect(
					Math.max(
						Math.abs(place.x - spot.you.x),
						Math.abs(place.y - spot.you.y)
					)
				).toBeGreaterThan(1);
			}
			expect(new Set(placed.map(key)).size).toBe(placed.length);
			if (narrow) {
				// A narrow stage queues down your column, inside the thin view.
				for (const place of Object.values(spot.slots)) {
					expect(Math.abs((place?.x ?? 99) - spot.you.x)).toBeLessThanOrEqual(
						1
					);
				}
			}
		}
		const spot = world2dYouSpot(layout, free);
		const { slots } = youSpotSlots(actsNow, []);
		const bo = actsNow.get(agentId("Bo"));
		const gu = actsNow.get(agentId("Gu"));
		const cy = actsNow.get(agentId("Cy"));
		if (!(bo && gu && cy)) {
			throw new Error("Bo, Gu and Cy");
		}
		const home = { x: 1, y: 1 };
		const boSlot = slots.find((slot) => slot.agentId === bo.agentId)?.point;
		expect(boSlot).toBeDefined();
		expect(world2dActorTile(bo, home, spot, slots, false)).toEqual(
			(boSlot && spot.slots[boSlot]) ?? home
		);
		// An asker without a queue place waits at home, not on a shared tile.
		expect(world2dActorTile(bo, home, spot, [], false)).toEqual(home);
		// Deliverers stand along the chest's row; reduced, they stay.
		expect(world2dActorTile(gu, home, spot, slots, false, 0)).toEqual(
			spot.trayRow[0] ?? home
		);
		expect(world2dActorTile(gu, home, spot, slots, false, 1)).toEqual(
			spot.trayRow[1] ?? home
		);
		expect(world2dActorTile(gu, home, spot, slots, true, 1)).toEqual(home);
		expect(world2dActorTile(cy, home, spot, slots, false)).toEqual(home);
		// No room anywhere: everyone stays home.
		const none = world2dYouSpot(layout, () => false);
		expect(none.tray).toBeNull();
		expect(world2dActorTile(bo, home, none, slots, false)).toEqual(home);
		expect(world2dActorTile(gu, home, none, slots, false, 0)).toEqual(home);
	});

	test("canvas act props: lamps, tools, helpers, next, limit time, wait tint", () => {
		const of = (name: string) => {
			const act = actsNow.get(agentId(name));
			if (!act) {
				throw new Error(name);
			}
			return actorAct(act, FIXTURE_NOW);
		};
		// One lamp per counted failure (Di's second: the nightly backup), a
		// dim one per old failure, and none for an interruption.
		expect(of("Di").alarms).toBe(2);
		expect(of("Ed").alarms).toBe(0);
		expect(of("Ed").interrupted).toBe(true);
		expect(of("Ha").oldAlarms).toBe(1);
		expect(of("Di").oldAlarms).toBe(0);
		// A working villager holds its step's tool, with its helpers and a
		// sign for the next step.
		expect(of("Cy").tool).toBe("quill");
		expect(of("Cy").followers).toBe(2);
		expect(of("Cy").next).toBe(true);
		expect(of("Io").tool).toBeNull();
		expect(of("Bo").next).toBe(false);
		// A limit shows when it is back.
		expect(of("Fa").back).toBe("15:10");
		expect(of("Cy").back).toBeNull();
		// An asker's plaque is tinted by how long it has waited.
		expect(of("Bo").waitTint).toBeDefined();
		expect(of("Cy").waitTint).toBeUndefined();
	});

	test("minimal overlay density drops pips, the estimate and the next sign", () => {
		const cy = actsNow.get(agentId("Cy"));
		if (!cy) {
			throw new Error("Cy");
		}
		expect(actorAct(cy, FIXTURE_NOW).next).toBe(true);
		expect(actorAct(cy, FIXTURE_NOW).pips).not.toBeNull();
		const minimal = actorAct(cy, FIXTURE_NOW, "minimal");
		expect(minimal.next).toBe(false);
		expect(minimal.pips).toBeNull();
		expect(minimal.estimate).toBe(false);
		// What it is doing still shows: its tool and its helpers.
		expect(minimal.tool).toBe("quill");
		expect(minimal.followers).toBe(2);
	});

	test("a thin view fits every asker, a post only where no '!' rises", () => {
		const layout = layoutWorld(fixture);
		const you = layout.spawn;
		// What a phone shows between the HUD and the hotbar: two rows by
		// your column, three tiles wide.
		const shown = (point: { x: number; y: number }) =>
			Math.abs(point.x - you.x) <= 1 &&
			point.y - you.y <= -1 &&
			point.y - you.y >= -2;
		const spot = world2dYouSpot(layout, shown, true, {
			posts: ["you-2"],
			villagers: ["you-1", "you-3", "you-4"],
		});
		const villagers = [
			spot.slots["you-1"],
			spot.slots["you-3"],
			spot.slots["you-4"],
		];
		for (const place of villagers) {
			expect(place).not.toBeNull();
			expect(place && shown(place)).toBe(true);
		}
		const placed = villagers.filter((place) => place !== null);
		for (const [index, place] of placed.entries()) {
			for (const other of placed.slice(index + 1)) {
				expect(
					Math.abs(place.x - other.x) + Math.abs(place.y - other.y)
				).toBeGreaterThan(1);
			}
		}
		// The rest of the view lies under the villagers' "!"s: no post.
		expect(spot.slots["you-2"]).toBeNull();
		// Unused slots get no place.
		expect(
			world2dYouSpot(layout, shown, true, { posts: [], villagers: ["you-1"] })
				.slots["you-2"]
		).toBeNull();
	});

	test("next to a queued asker, E opens its ask; Ctrl+E does not", async () => {
		const container = await mount(world(fixture));
		const map = container.querySelector<HTMLElement>('[role="application"]');
		if (!map) {
			throw new Error("Expected the world map");
		}
		const key = async (init: KeyboardEventInit) => {
			await act(async () => {
				map.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, ...init })
				);
			});
		};
		const card = () => document.querySelector("[data-ask-card]");
		// From your doorstep the first queue place is two tiles off (down your
		// column on this narrow stage, else along your row): step to it.
		for (const step of [
			"ArrowDown",
			"ArrowUp",
			"ArrowRight",
			"ArrowLeft",
			"ArrowLeft",
		]) {
			if (map.textContent?.includes("Answer")) {
				break;
			}
			await key({ key: step });
		}
		expect(map.textContent).toContain("Answer");
		await key({ ctrlKey: true, key: "e" });
		expect(card()).toBeNull();
		await key({ key: "e" });
		expect(card()?.textContent ?? "").toMatch(/\?/);
	});

	test("redacted, the hotbar and talk box keep asks and work private", async () => {
		const hidden = usefulStateFixture({ privacy: "redacted" });
		const container = await mount(world(hidden));
		const labels = [
			...container.querySelectorAll<HTMLElement>(
				'nav[aria-label="Villagers"] [data-act-agent]'
			),
		]
			.map((slot) => slot.getAttribute("aria-label") ?? "")
			.join(" ");
		expect(labels).not.toContain("Which DB to use?");
		expect(labels).not.toContain("snapshot.ts");
		const hiddenActs = agentActs(hidden, FIXTURE_NOW, FIXTURE_CLOCK);
		for (const name of ["Bo", "Gu", "Di"]) {
			const found = hiddenActs.get(agentId(name));
			if (!found) {
				throw new Error(name);
			}
			const line = world2dActLine(found, hidden.threads, "redacted") ?? "";
			expect(line).not.toContain("Which DB to use?");
			expect(line).not.toContain("Edited 3 files");
			expect(line).not.toContain("Tests failed");
		}
	});

	test("13b: keys typed in the queue and the agent list never drive the world", async () => {
		const container = await mount(world(fixture));
		const page = () =>
			container.querySelector('nav[aria-label="Villagers"]')?.textContent ?? "";
		const before = page();
		const mapShown = () =>
			container.querySelector('canvas[aria-label^="Village map:"]') !== null;
		const targets = [
			container.querySelector<HTMLElement>("[data-ask-queue] button"),
			container.querySelector<HTMLElement>("[data-act-agent-list] button"),
		];
		for (const target of targets) {
			expect(target).not.toBeNull();
			for (const key of ["1", "m", "[", "?"]) {
				act(() => {
					target?.dispatchEvent(
						new KeyboardEvent("keydown", { bubbles: true, key })
					);
				});
			}
		}
		await settle();
		expect(mapShown()).toBe(false);
		expect(page()).toBe(before);
		expect(document.querySelector("[data-ask-card]")).toBeNull();
	});

	test("13h: with the opener and every queue button gone, focus lands on the h1", async () => {
		const only = usefulStateFixture({ agents: ["bo"] });
		let setSnapshot: ((next: InterfaceSnapshot) => void) | null = null;
		function Host() {
			const [snapshot, set] = useState<InterfaceSnapshot>(only);
			setSnapshot = set;
			return world(snapshot);
		}
		const container = await mount(<Host />);
		const needYou = container.querySelector<HTMLElement>("[data-need-you]");
		act(() => needYou?.focus());
		await press(needYou);
		expect(document.querySelector("[data-ask-card]")).not.toBeNull();
		act(() => setSnapshot?.({ ...only, asks: [], threads: [] }));
		await settle();
		const close = [
			...(document
				.querySelector("[data-ask-card]")
				?.querySelectorAll("button") ?? []),
		].find((button) => button.textContent === "Close");
		await press(close);
		await settle(60);
		expect(document.activeElement?.textContent).toBe("World 2D");
	});

	test("test 21: the queue's buttons in order, and ten agent rows", async () => {
		const container = await mount(world(fixture));
		const queue = [
			...container.querySelectorAll("[data-ask-queue] button"),
		].map((button) => (button.textContent ?? "").split(":")[0]);
		expect(queue).toEqual([
			"Bo",
			"Inbox",
			"Ada",
			"Di",
			"Ed",
			"Di",
			"Ha",
			"Gu",
			"Ju",
		]);
		expect(
			container.querySelectorAll("[data-act-agent-list] [data-act-agent]")
		).toHaveLength(10);
	});

	test("without asks the world is unchanged", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		// Ids and the live clock's timestamp differ between mounts.
		const sansIds = (html: string) =>
			html
				.replace(/_r_\w+_/g, "_r_")
				.replace(/datetime="[^"]+"/g, 'datetime="_"');
		const acted = await mount(world(oldHost));
		const plain = await mount(world(oldHost, false));
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});

	test("Need you opens the first ask's card, outside the map's keys", async () => {
		const container = await mount(world(fixture));
		await press(container.querySelector("[data-need-you]"));
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Which DB to use?");
		expect(
			container.querySelector(`[data-act-agent="${agentId("Bo")}"]`)
		).not.toBeNull();
	});
});
