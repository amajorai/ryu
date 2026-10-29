import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The act props are drei `Html` plates over three.js meshes; outside a
// Canvas, render the plates in place and give the frame hooks a stand-in.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
const fiber = await import("@react-three/fiber");
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: () => undefined,
	useThree: (select?: (state: unknown) => unknown) => {
		const state = { invalidate: () => undefined };
		return select ? select(state) : state;
	},
}));

// Toon materials build three.js textures; the props' meshes are not under test.
const materials = await import("./game3d-materials.tsx");
mock.module("./game3d-materials.tsx", () => ({
	...materials,
	CurvedBasicMaterial: () => null,
	ToonMaterial: () => null,
	ToonMesh: () => null,
}));

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const {
	actOverlays,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} = await import("./game3d-acts.ts");
const { askOwners } = await import("./interface-ask-card.tsx");
const { ArcadeActProps, arcadePaths, arcadePlayer } = await import(
	"./arcade-acts.tsx"
);
const { layoutHall, playerSpot } = await import("./arcade-diorama.tsx");
const { buildFloor } = await import("./arcade-model.ts");

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

/**
 * Test 21 for the arcade: the act props it draws in the hall, rendered on
 * the hall's own layout (`layoutHall` with the you-spot, players at
 * `playerSpot`) at 1280 and 390, and the players' plates from
 * `arcadePlayer`. Every exempt target (the
 * alarms, the notice, the tray item, the unread mark and the suggestion
 * note) is a focusable control with its full name; at 390 the ones that
 * are not queue plates collapse to glyphs; the budgeted status words stay
 * within 8 at 390.
 */
function renderProps(width: number) {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const unowned = unownedAsks(snapshot);
	const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
	const slots = youSpotSlots(
		acts,
		unowned,
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(actOverlays(onStage, slots, offStage));
	const hall = layoutHall(
		buildFloor(snapshot, null).machines,
		width < 640,
		true
	);
	const stations = new Map(
		hall.cabinets.map((cabinet) => {
			const [x, z] = playerSpot(cabinet);
			return [cabinet.machine.agent.id, [x, 0.16, z]] as [
				string,
				[number, number, number],
			];
		})
	);
	if (!hall.you) {
		throw new Error("the act hall has no you-spot");
	}
	const { layout } = hall.you;
	const view = {
		acts,
		clock: FIXTURE_CLOCK,
		iconOnly: budget.iconOnly,
		nowMs: FIXTURE_NOW,
		offStage,
		onAsk: () => undefined,
		onBlocker: () => undefined,
		onQueue: () => undefined,
		owners: askOwners(acts),
		privacy: "full" as const,
		shown,
		slots,
		snapshot,
	};
	const paths = arcadePaths(stations, hall.you.points, 0.16);
	const players = onStage.flatMap((act) =>
		arcadePlayer({
			act,
			base: {
				id: act.agentId,
				position: stations.get(act.agentId) ?? [0, 0, 0],
			},
			label: "Open the machine.",
			looks: {} as never,
			paths,
			reduced: true,
			view,
		})
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() =>
			root.render(
				<ArcadeActProps
					onStage={onStage}
					reduced
					stations={stations}
					view={view}
					youLayout={layout}
				/>
			)
		);
	} catch (error) {
		console.error = errors;
		const inner = (error as { errors?: unknown[] }).errors ?? [error];
		throw new Error(inner.map((item) => String(item)).join("\n"));
	} finally {
		console.error = errors;
	}
	const dispose = () => {
		act(() => root.unmount());
		container.remove();
	};
	return { container, dispose, onStage, players, shown };
}

const EXPECTED = { alarm: 3, notice: 1, suggestion: 1, tray: 1, unread: 1 };

describe("arcade act props (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`every exempt target is a focusable, named control at ${width}`, () => {
			const { container, dispose } = renderProps(width);
			try {
				for (const [kind, count] of Object.entries(EXPECTED)) {
					const targets = [
						...container.querySelectorAll<HTMLButtonElement>(
							`[data-act-target="${kind}"]`
						),
					];
					expect(targets).toHaveLength(count);
					for (const target of targets) {
						expect(target.tabIndex).toBe(0);
						expect(target.hasAttribute("data-iso-target")).toBe(true);
						expect(target.getAttribute("aria-label")?.length).toBeGreaterThan(
							10
						);
						// Queue plates keep their words; the rest are glyphs at 390.
						const glyph = target.hasAttribute("data-icon-only");
						expect(glyph).toBe(width < 640 && kind !== "notice");
					}
				}
				const names = [
					...container.querySelectorAll('[data-act-target="alarm"]'),
				].map((item) => item.getAttribute("aria-label"));
				expect(names).toContain("Di stopped: Tests failed, 20 minutes ago.");
				expect(names).toContain("Ed stopped: Interrupted, about 1 hour ago.");
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(width < 640 ? 8 : 16);
			} finally {
				dispose();
			}
		});
	}

	test("the limit reads INSERT COIN with its reset time", () => {
		const { container, dispose } = renderProps(1280);
		try {
			const words = [
				...container.querySelectorAll('[data-budgeted-overlay="limit"]'),
			].map((item) => item.textContent);
			expect(words).toEqual(["INSERT COIN 15:10"]);
		} finally {
			dispose();
		}
	});

	for (const width of [1280, 390]) {
		test(`the asking players are per-agent queue plates at ${width}`, () => {
			const { dispose, players } = renderProps(width);
			try {
				const queued = players.filter((spec) => spec.youSpot === "slot");
				expect(queued.map((spec) => spec.actAgent).sort()).toEqual([
					"ada",
					"bo",
				]);
				for (const spec of queued) {
					expect(spec.activate).toBeDefined();
					expect(spec.iconOnly).toBe(false);
					expect(spec.label.endsWith("Answer their ask.")).toBe(true);
				}
				// Every on-stage player is its agent's one target.
				const agents = players.flatMap((spec) =>
					spec.actAgent ? [spec.actAgent] : []
				);
				expect(new Set(agents).size).toBe(agents.length);
			} finally {
				dispose();
			}
		});
	}

	for (const width of [1280, 390]) {
		test(`the budget caps the words and bubbles at ${width}; one player per agent`, () => {
			const { container, dispose, onStage, players, shown } =
				renderProps(width);
			try {
				// What is drawn, not what the budget chose: the rendered
				// budgeted words plus every player bubble that shows.
				const words = container.querySelectorAll(
					"[data-budgeted-overlay]"
				).length;
				const bubbles = players.flatMap((spec) => {
					const act = onStage.find((item) => item.agentId === spec.actAgent);
					const id = act ? bubbleOverlayId(act) : null;
					return id && spec.bubble !== false ? [id] : [];
				});
				expect(words + bubbles.length).toBeLessThanOrEqual(
					width < 640 ? 8 : 16
				);
				expect(words + bubbles.length).toBeGreaterThan(0);
				// A bubble shows only when the budget chose it.
				for (const id of bubbles) {
					expect(shown.has(id)).toBe(true);
				}
				for (const act of onStage) {
					const specs = players.filter((spec) => spec.actAgent === act.agentId);
					expect(specs).toHaveLength(1);
					if (act.act === "asking") {
						expect(specs[0]?.activate).toBeDefined();
					}
				}
				if (width < 640) {
					// No ask bubble on a phone; the limit still reads INSERT COIN.
					for (const spec of players) {
						const act = onStage.find((item) => item.agentId === spec.actAgent);
						if (act?.act === "asking") {
							expect(spec.bubble).toBe(false);
						}
					}
					const limit = [
						...container.querySelectorAll('[data-budgeted-overlay="limit"]'),
					].map((item) => item.textContent);
					expect(limit.join(" ")).toContain("INSERT COIN");
				}
			} finally {
				dispose();
			}
		});
	}
});
