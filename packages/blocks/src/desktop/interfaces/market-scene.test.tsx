import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The act props and keeper plates are drei `Html` plates over three.js
// meshes; outside a Canvas, render the plates in place and give the frame
// hooks a stand-in.
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
const { FIXTURE_AGENT_IDS, FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } =
	await import("./game-acts-fixture.ts");
const { stageAgents, youSpotSlots } = await import("./game3d-acts.ts");
const { VillagerPlate } = await import("./game3d-villager.tsx");
const { askOwners } = await import("./interface-ask-card.tsx");
const {
	actKeepers,
	actShops,
	keeperStations,
	MarketActProps,
	marketActPaths,
	marketShownOverlays,
	upcomingRuns,
} = await import("./market-acts.tsx");
const {
	ACT_EAST_SPACING,
	ACT_KEEPER_SPACING,
	ACT_KEEPER_SPACING_NARROW,
	ACT_MIN_SQUARE,
	ACT_MIN_SQUARE_NARROW,
	buildMarket,
	layoutMarket,
} = await import("./market-model.ts");

afterAll(async () => {
	mock.restore();
	await GlobalRegistrator.unregister();
});

/**
 * Test 21 for the market: the act props (MarketActProps) and the keeper
 * plates exactly as MarketInterface builds them at a 1280 and a 390 stage
 * (its street layout, overlay budget and keeper cast), rendered as the
 * kit's plates.
 */
function renderStreet(width: number) {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const unowned = unownedAsks(snapshot);
	const narrow = width < 640;
	const shops = actShops(buildMarket(snapshot), acts);
	const runs = upcomingRuns(shops, snapshot.events);
	const block = layoutMarket(shops, {
		backInset: narrow ? 0.9 : undefined,
		eastSpacing: narrow ? ACT_KEEPER_SPACING_NARROW : ACT_EAST_SPACING,
		queue: new Map([...runs].map(([id, events]) => [id, events.length])),
		spacing: narrow ? ACT_KEEPER_SPACING_NARROW : ACT_KEEPER_SPACING,
		square: narrow ? ACT_MIN_SQUARE_NARROW : ACT_MIN_SQUARE,
	});
	const stations = keeperStations(block);
	const paths = marketActPaths(block, stations, narrow);
	const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
	const slots = youSpotSlots(acts, unowned);
	const { budget, shown } = marketShownOverlays({
		offStage,
		onStage,
		reduced: true,
		slots,
		width,
	});
	const keepers = actKeepers({
		acts,
		looks: new Map(snapshot.agents.map((agent) => [agent.id, {} as never])),
		nowMs: FIXTURE_NOW,
		onAsk: () => undefined,
		paths,
		reduced: true,
		shown,
		slots: slots.slots,
		stations,
	}).filter((spec) => spec.actAgent);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() =>
			root.render(
				<>
					{keepers.map((spec) => (
						<VillagerPlate
							iconOnly={spec.iconOnly ?? budget.iconOnly}
							key={spec.id}
							onSelect={() => undefined}
							selected={false}
							spec={spec}
						/>
					))}
					<MarketActProps
						acts={acts}
						block={block}
						clock={FIXTURE_CLOCK}
						iconOnly={budget.iconOnly}
						nowMs={FIXTURE_NOW}
						offStage={offStage}
						onAsk={() => undefined}
						onBlocker={() => undefined}
						onQueue={() => undefined}
						onStage={onStage}
						owners={askOwners(acts)}
						reduced
						shown={shown}
						slots={slots}
						snapshot={snapshot}
						stations={stations}
					/>
				</>
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
	return { acts, container, dispose, keepers };
}

const EXPECTED = { alarm: 3, notice: 1, suggestion: 1, tray: 1, unread: 1 };

describe("market act props and keeper plates (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`every exempt target is a focusable, named control at ${width}`, () => {
			const { acts, container, dispose } = renderStreet(width);
			const narrow = width < 640;
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
						// The notice is a queue plate: it keeps its words at 390.
						expect(target.hasAttribute("data-icon-only")).toBe(
							narrow && kind !== "notice"
						);
					}
				}
				const alarms = [
					...container.querySelectorAll('[data-act-target="alarm"]'),
				].map((item) => item.getAttribute("aria-label"));
				expect(alarms).toContain("Di stopped: Tests failed, 20 minutes ago.");
				expect(alarms).toContain("Ed stopped: Interrupted, about 1 hour ago.");
				// One plate per keeper on the street: a Tab stop named by its act.
				const plates = [
					...container.querySelectorAll<HTMLButtonElement>(
						"button[data-act-agent]"
					),
				];
				expect(plates).toHaveLength(acts.size);
				for (const plate of plates) {
					const keeper = acts.get(plate.getAttribute("data-act-agent") ?? "");
					expect(plate.tabIndex).toBe(0);
					expect(plate.getAttribute("aria-label")).toStartWith(
						keeper?.ariaLabel ?? "(none)"
					);
					// Queued keepers' plates keep their words ("Ada · 14m"); the
					// others are initials at 390.
					const queued = plate.getAttribute("data-you-spot") === "slot";
					expect(plate.hasAttribute("data-icon-only")).toBe(narrow && !queued);
					if (queued) {
						expect(plate.textContent).toContain(" · ");
					}
				}
				expect(
					plates.filter(
						(plate) => plate.getAttribute("data-you-spot") === "slot"
					).length
				).toBeGreaterThan(0);
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(narrow ? 8 : 16);
			} finally {
				dispose();
			}
		});
	}
	test("exempt targets carry their exact names, the same at 390 as at 1280", () => {
		const names = (width: number) => {
			const { container, dispose } = renderStreet(width);
			try {
				return {
					slots: [
						...container.querySelectorAll(
							"button[data-act-agent][data-you-spot='slot']"
						),
					].map((item) => item.getAttribute("data-act-agent")),
					targets: [...container.querySelectorAll("[data-act-target]")].map(
						(item) => [
							item.getAttribute("data-act-target"),
							item.getAttribute("aria-label"),
						]
					),
				};
			} finally {
				dispose();
			}
		};
		const wide = names(1280);
		expect(wide.targets).toEqual([
			[
				"notice",
				"Inbox asks: Workflow gate: Deploy. Waited 20 minutes. Risk: workflow.",
			],
			["tray", "Gu has an answer ready: Edited 3 files. Waiting 40 minutes."],
			["alarm", "Ed stopped: Interrupted, about 1 hour ago."],
			[
				"suggestion",
				"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours.",
			],
			[
				"unread",
				"Ju has an answer ready: Here is the weekly report summary you asked for. Waiting about 1 day.",
			],
			["alarm", "Di stopped: Tests failed, 20 minutes ago."],
			["alarm", "Di stopped: Nightly backup failed, 6 hours ago."],
		]);
		// The keepers queued at the cross are exactly Bo and Ada.
		expect(wide.slots).toEqual([FIXTURE_AGENT_IDS.bo, FIXTURE_AGENT_IDS.ada]);
		// Icon-only on a phone, the names are the same.
		expect(names(390)).toEqual(wide);
	});
});
