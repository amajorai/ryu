import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The town's targets are DOM overlay buttons (town-overlay.tsx), so their
// contract renders without WebGL: register the DOM, then import.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const {
	actBubble,
	actOverlays,
	actTotals,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} = await import("./game3d-acts.ts");
const { askOwners } = await import("./interface-ask-card.tsx");
const { actTown, beaconTone, TownActProps, townActEntries } = await import(
	"./town-acts.tsx"
);
const { TownOverlay } = await import("./town-overlay.tsx");
const { buildTown } = await import("./town-model.ts");

const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const staged = stageAgents(acts, Number.POSITIVE_INFINITY);
const slots = youSpotSlots(acts, unownedAsks(fixture));
const town = actTown(buildTown(fixture, FIXTURE_NOW), acts);
const ADA =
	"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.";

function render(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(node));
	return {
		container,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/** The overlay with its act layer, as the town draws it at `width`. */
function overlay(width: number, opened: string[], selectedId: string | null) {
	const budget = overlayBudget(width, { domTargets: true });
	// As the interface fills it: the working focus first, no phone work bubbles.
	const shown = budget.fill(
		actOverlays(
			staged.onStage,
			slots,
			{ count: 0 },
			staged.onStage.find((item) => item.act === "working")?.agentId ?? null,
			{ reduced: true }
		).filter((item) => !(budget.iconOnly && item.id.startsWith("work:")))
	);
	// The bubbles the budget kept, as the interface hangs them.
	const bubbles = new Map<string, NonNullable<ReturnType<typeof actBubble>>>();
	for (const item of acts.values()) {
		const id = bubbleOverlayId(item);
		const bubble = id && shown.has(id) ? actBubble(item) : null;
		if (bubble) {
			bubbles.set(item.agentId, bubble);
		}
	}
	const entries = townActEntries({
		acts,
		bubbles,
		nowMs: FIXTURE_NOW,
		overflow: slots.overflow,
		owners: askOwners(acts),
		shown,
		slots: slots.slots,
		snapshot: fixture,
		town,
	});
	return render(
		<TownOverlay
			actLayer={{
				acts,
				bubbles,
				needYou: actTotals(fixture, acts).needYou,
				onAsk: (askId) => opened.push(askId),
				props: (
					<TownActProps
						entries={entries}
						handlers={{
							clock: FIXTURE_CLOCK,
							iconOnly: budget.iconOnly,
							nowMs: FIXTURE_NOW,
							onAsk: (askId) => opened.push(askId),
							onBlocker: (threadId) => opened.push(`blocker:${threadId}`),
							onQueue: () => opened.push("queue"),
							privacy: "full",
							snapshot: fixture,
						}}
					/>
				),
			}}
			hoverId={null}
			layerRef={null}
			onBuilding={(agentId) => opened.push(`building:${agentId}`)}
			onDistrict={() => undefined}
			onHall={() => undefined}
			onHover={() => undefined}
			selectedId={selectedId}
			showCounts
			showTags
			town={town}
		/>
	);
}

type PlacedLabelShape = import("./town-scene.tsx").PlacedLabel;

const buildingOf = (container: HTMLElement, agentId: string) =>
	container.querySelector<HTMLElement>(`[data-act-agent='${agentId}']`);

describe("town scene targets", () => {
	test("15a: Ada's building answers her ask (no aria-pressed); Cy's opens its card and keeps aria-pressed", () => {
		const opened: string[] = [];
		const view = overlay(1280, opened, null);
		const ada = buildingOf(view.container, "ada");
		expect(ada?.getAttribute("aria-label")).toBe(`${ADA} Answer their ask.`);
		expect(ada?.hasAttribute("aria-pressed")).toBe(false);
		act(() => ada?.click());
		expect(opened).toEqual(["approval:ada-shell"]);
		const cy = buildingOf(view.container, "cy");
		expect(cy?.getAttribute("aria-label")).toBe(
			`${acts.get("cy")?.ariaLabel} Open its card.`
		);
		expect(cy?.getAttribute("aria-pressed")).toBe("false");
		act(() => cy?.click());
		expect(opened.at(-1)).toBe("building:cy");
		// The only Tab stops are buildings, act props, district signs and City
		// Hall: no townsfolk or name tag is one.
		for (const stop of view.container.querySelectorAll<HTMLElement>(
			"button, [tabindex]"
		)) {
			if (stop.tabIndex < 0) {
				continue;
			}
			const known =
				stop.hasAttribute("data-act-agent") ||
				stop.hasAttribute("data-act-target") ||
				stop.closest("[aria-label='Districts on the map']") !== null ||
				(stop.getAttribute("aria-label") ?? "").startsWith("City Hall");
			expect(known).toBe(true);
		}
		view.unmount();
	});

	for (const width of [1280, 390]) {
		test(`21: every exempt target is rendered and focusable at ${width}`, () => {
			const opened: string[] = [];
			const view = overlay(width, opened, null);
			const props = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-target]"),
			];
			const kinds = props.map((item) => item.dataset.actTarget);
			expect(kinds.filter((kind) => kind === "alarm")).toHaveLength(3);
			expect(kinds.filter((kind) => kind === "notice")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "tray")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "unread")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "suggestion")).toHaveLength(1);
			for (const item of props) {
				expect(item.tabIndex).toBe(0);
				expect(item.getAttribute("aria-label")?.length).toBeGreaterThan(10);
				expect(item.hasAttribute("data-icon-only")).toBe(
					width < 640 && item.dataset.actTarget !== "notice"
				);
			}
			// The queue: Ada and Bo at the steps, the gate's notice.
			expect(
				view.container.querySelectorAll("[data-you-spot='slot']")
			).toHaveLength(3);
			// One building per agent, each its one Tab stop, named by its act.
			const buildings = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-agent]"),
			];
			expect(buildings.map((item) => item.dataset.actAgent).sort()).toEqual(
				[...acts.keys()].sort()
			);
			for (const building of buildings) {
				expect(building.getAttribute("aria-label")).toStartWith(
					acts.get(building.dataset.actAgent ?? "")?.ariaLabel ?? "missing"
				);
			}
			// The budget's status words and bubbles stay within its cap.
			const budgeted = view.container.querySelectorAll(
				"[data-budgeted-overlay]"
			).length;
			expect(budgeted).toBeGreaterThan(0);
			expect(budgeted).toBeLessThanOrEqual(
				overlayBudget(width, { domTargets: true }).cap
			);
			// Fa's limit is a sign at her door, at every width.
			expect(view.container.textContent).toContain("Closed till");
			act(() =>
				props.find((item) => item.dataset.actTarget === "tray")?.click()
			);
			expect(opened).toEqual(["reply:t-gu"]);
			view.unmount();
		});
	}

	test("with acts the district signs carry no legacy conversation count", () => {
		const view = overlay(1280, [], null);
		const signs = [
			...view.container.querySelectorAll<HTMLElement>(
				"[aria-label='Districts on the map'] button"
			),
		];
		expect(signs.length).toBe(town.districts.length);
		for (const [index, sign] of signs.entries()) {
			expect(sign.textContent).toBe(town.districts[index]?.name ?? "missing");
			expect(sign.getAttribute("aria-label")).not.toContain("conversation");
		}
		view.unmount();
	});

	test("building art follows the acts: a crane only for work, beacons only for counted blockers", () => {
		const byId = new Map(town.buildings.map((item) => [item.agent.id, item]));
		expect(byId.get("cy")?.working).toBe(true);
		expect(byId.get("fa")?.working).toBe(false);
		expect(byId.get("di")?.alarm).toBe("red");
		expect(byId.get("ed")?.alarm).toBe("grey");
		// Ha's failure is too old to count: nothing is lit.
		expect(byId.get("ha")?.alert).toBe(false);
		for (const building of town.buildings) {
			expect(building.replied).toBe(false);
		}
		// d8: each district's Waiting counts its asking and stopped agents,
		// not a limited one (Fa waits on her limit, not on you).
		for (const district of town.districts) {
			const expected = district.buildings.filter((building) => {
				const state = acts.get(building.agent.id)?.act;
				return state === "asking" || state === "blocked";
			}).length;
			expect(district.petitions).toBe(expected);
		}
		const total = town.districts.reduce((sum, item) => sum + item.petitions, 0);
		expect(total).toBe(
			[...acts.values()].filter(
				(item) => item.act === "asking" || item.act === "blocked"
			).length
		);
		expect(acts.get("fa")?.act).toBe("limited");
	});

	describe("settleLabels", () => {
		const node = (x: number, y: number) => {
			const element = document.createElement("span");
			element.style.left = `${x}px`;
			element.style.top = `${y}px`;
			return element;
		};
		const label = (
			rank: number,
			x = 100,
			y = 100,
			extra: Partial<PlacedLabelShape> = {}
		): PlacedLabelShape => ({
			element: node(x, y),
			height: 24,
			mode: "lift",
			movable: true,
			rank,
			width: 80,
			x,
			y,
			...extra,
		});
		const stage = { height: 600, width: 600 };

		test("crowded act props find room nearby, never more than a label width away", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			const a = label(6);
			const b = label(6);
			settleLabels([a, b], stage);
			expect(b.element.style.visibility).not.toBe("hidden");
			expect(
				Math.abs(a.x - b.x) >= a.width || Math.abs(a.y - b.y) >= a.height
			).toBe(true);
			expect(Math.abs(b.x - 100)).toBeLessThanOrEqual(b.width);
			expect(Math.abs(b.y - 100)).toBeLessThanOrEqual(2 * (b.height + 5));
		});

		test("with no room nearby an act prop keeps its own place; a name tag hides", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			// A wall of fixed labels round the point.
			const wall = [];
			for (let dx = -240; dx <= 240; dx += 80) {
				for (let dy = -96; dy <= 96; dy += 24) {
					wall.push(label(9, 100 + dx, 200 + dy, { movable: false }));
				}
			}
			const prop = label(6, 100, 200);
			const tag = label(0, 100, 200);
			settleLabels([...wall, prop, tag], stage);
			expect(prop.x).toBe(100);
			expect(prop.y).toBe(200);
			expect(prop.element.style.visibility).not.toBe("hidden");
			expect(tag.element.style.visibility).toBe("hidden");
		});

		test("a tag whose bubble may flip hangs it left before moving", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			const bubble = document.createElement("span");
			bubble.dataset.side = "right";
			// Something on the right of the tag, where its bubble would hang.
			const right = label(9, 200, 100, { movable: false });
			const tag = label(6, 120, 100, {
				bubble: { element: bubble, left: { width: 160, x: 30 } },
				width: 160,
			});
			settleLabels([right, tag], stage);
			expect(bubble.dataset.side).toBe("left");
			expect(tag.x).toBe(30);
			expect(tag.y).toBe(100);
		});

		test("labels keep clear of the HUD's insets", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			const tag = label(0, 20, 20);
			settleLabels([tag], stage, { bottom: 0, left: 0, right: 0, top: 120 });
			// No place clear of the inset nearby: it hides rather than sit under the HUD.
			expect(tag.element.style.visibility).toBe("hidden");
		});

		test("a crowded queue stacks 8 px apart, never under the HUD", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			// Walls either side and above leave the plate no slide room.
			const walls = [-120, 0, 120].flatMap((dx) =>
				[-72, -48, -24].map((dy) =>
					label(9, 300 + dx, 300 + dy, { movable: false })
				)
			);
			const first = label(7, 300, 300, { youSpot: true });
			const second = label(7, 300, 300, { youSpot: true });
			settleLabels([...walls, first, second], stage);
			expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(8);
			// Near the HUD, with no slide room, the queue stacks upward: never
			// under the inset, never on another plate.
			const hudWalls = [220, 300, 380].flatMap((x) =>
				[440, 464].map((y) => label(9, x, y, { movable: false }))
			);
			const low = label(7, 300, 500, { youSpot: true });
			const lower = label(7, 300, 500, { youSpot: true });
			settleLabels([...hudWalls, low, lower], stage, {
				bottom: 70,
				left: 0,
				right: 0,
				top: 0,
			});
			expect(low.y).toBe(500);
			expect(lower.y + lower.height).toBeLessThanOrEqual(600 - 70);
			const clear = (a: typeof low, b: typeof low) =>
				a.y + a.height <= b.y ||
				b.y + b.height <= a.y ||
				a.x + a.width <= b.x ||
				b.x + b.width <= a.x;
			for (const other of [low, ...hudWalls]) {
				expect(clear(lower, other)).toBe(true);
			}
			expect(low.y - (lower.y + lower.height)).toBeGreaterThanOrEqual(8);
		});

		test("queue plates hold their slot and keep 8 px from each other", async () => {
			const { settleLabels } = await import("./town-scene.tsx");
			const a = label(7, 100, 100, { youSpot: true });
			const b = label(7, 100, 130, { youSpot: true });
			settleLabels([a, b], stage);
			expect(a.x).toBe(100);
			expect(b.x).toBe(100);
			const gap = Math.abs(b.y - a.y) - a.height;
			expect(gap).toBeGreaterThanOrEqual(8);
		});
	});

	test("t7: the beacon takes the most severe counted blocker, whatever its order", () => {
		const di = acts.get("di");
		expect(di && beaconTone(di)).toBe("red");
		const limited = acts.get("fa");
		expect(limited && beaconTone(limited)).toBeUndefined();
		const red = di?.blockers.find(
			(blocker) => blocker.kind !== "schedule-failed"
		);
		if (!(di && red)) {
			throw new Error("missing fixture acts");
		}
		// A limit first and a failure after still lights red; a limit alone
		// lights nothing.
		const limit = { ...red, kind: "rate-limited" as const };
		expect(beaconTone({ ...di, blockers: [limit, red] })).toBe("red");
		expect(beaconTone({ ...di, blockers: [limit] })).toBeUndefined();
	});
});
