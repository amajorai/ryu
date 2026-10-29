// The DOM first, before React loads (seasonal-test-dom.ts).
import "./seasonal-test-dom.ts";
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { seasonalDom } from "./seasonal-test-dom.ts";

// Again here: another Seasonal test file may have taken the DOM down.
seasonalDom();

// The DOM is registered first (seasonal-test-dom.ts), before React loads.
// The act props, door badges and villager plates are drei `Html` plates
// over three.js meshes; outside a Canvas, render the plates in place and
// give the frame hooks a stand-in. Each mock spreads the real module, so a
// later test file in the same run (Bun shares module mocks across files)
// still finds every export.
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
		const state = {
			camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1 },
			gl: { domElement: globalThis.document?.createElement("canvas") },
			invalidate: () => undefined,
			size: { height: 800, width: 1280 },
		};
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
// The wait timers record what they are given (the season's candle skin).
const timerProps: { color?: string; shape?: string }[] = [];
const meters = await import("./game3d-meters.tsx");
mock.module("./game3d-meters.tsx", () => ({
	...meters,
	WaitTimer3D: (props: { color?: string; shape?: string }) => {
		timerProps.push(props);
		return null;
	},
}));
const instances = await import("./game3d-instances.tsx");
mock.module("./game3d-instances.tsx", () => ({
	...instances,
	InstancedParts: () => null,
}));

// The square, the patch and the street are scenery built of three.js
// objects on mount; they are not under test.
const stub = () => null;
const stubbed = async (path: string, names: readonly string[]) => {
	const real = await import(path);
	mock.module(path, () => ({
		...real,
		...Object.fromEntries(names.map((name) => [name, stub])),
	}));
};
await stubbed("./seasonal-village.tsx", ["AdventSquare"]);
await stubbed("./seasonal-patch.tsx", ["PumpkinPatch"]);
await stubbed("./seasonal-street.tsx", ["LanternStreet"]);

// Villagers build three.js rigs: stand them in as their plates, wired as
// the diorama wires them (a plate's select opens its focus door).
const villager = await import("./game3d-villager.tsx");
const { VillagerPlate } = villager;
mock.module("./game3d-villager.tsx", () => ({
	...villager,
	Villagers: ({
		iconOnly,
		onSelect,
		villagers,
	}: {
		iconOnly?: boolean;
		onSelect?: (id: string) => void;
		villagers: readonly import("./game3d-villager.tsx").VillagerSpec[];
	}) =>
		villagers.map((spec) => (
			<VillagerPlate
				iconOnly={spec.iconOnly ?? iconOnly}
				key={spec.id}
				onSelect={() => onSelect?.(spec.id)}
				selected={false}
				spec={spec}
			/>
		)),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} = await import("./game-acts-fixture.ts");
const { actOverlays, blockerEntries, nextRunOf, overlayBudget, youSpotSlots } =
	await import("./game3d-acts.ts");
const { NextSign } = await import("./game3d-signs.tsx");
const { islandFor } = await import("./game3d-ground.tsx");
const { GAME3D_NIGHT } = await import("./game3d-palette.ts");
const { askOwners } = await import("./interface-ask-card.tsx");
const {
	actVillagers,
	boardAgents,
	doorActs,
	SeasonActProps,
	seasonActPaths,
	seasonHelperDress,
	seasonNext,
	seasonStations,
	TomorrowDoor,
} = await import("./seasonal-acts.tsx");
const { SEASON_ACT_ART } = await import("./seasonal-palette.ts");
const { SeasonDiorama } = await import("./seasonal-diorama.tsx");
const { buildBoard, doorLabel, SEASON_COPY } = await import(
	"./seasonal-model.ts"
);
const { layoutSeasonWorld } = await import("./seasonal-world.ts");

afterAll(() => {
	mock.restore();
});

type Season = "advent" | "halloween" | "lunar-new-year";

/**
 * The diorama with its act layer exactly as SeasonalInterface builds it at
 * a `width` stage (its overlay budget, stations, cast and props), the
 * scenery left out, rendered as the kit's plates.
 */
function renderBoard(
	season: Season,
	width: number,
	privacy: "full" | "redacted" = "full"
) {
	const snapshot = { ...usefulStateFixture(), privacy };
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const board = buildBoard(snapshot, {}, null, doorActs(snapshot, acts));
	const world = layoutSeasonWorld(season, true);
	const stations = seasonStations(season, world, board.doors, acts);
	const { offStage, onStage } = boardAgents(acts, stations);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(
		actOverlays(
			onStage,
			slots,
			offStage,
			onStage.find((item) => item.act === "working")?.agentId ?? null,
			{ reduced: true }
		)
	);
	const paths = seasonActPaths(season, stations);
	const asked: string[] = [];
	const activated: number[] = [];
	const looks = new Map(
		snapshot.agents.map((agent) => [agent.id, {} as never])
	);
	const villagers = actVillagers({
		acts,
		looks,
		nowMs: FIXTURE_NOW,
		onAsk: (askId) => asked.push(askId),
		paths,
		reduced: true,
		season,
		shown,
		slots: slots.slots,
		stations,
	});
	const stopped = blockerEntries(snapshot, acts).flatMap((entry) => {
		const number = board.doors.find(
			(door) => door.thread?.id === entry.threadId
		)?.number;
		const place = world.doors.find((item) => item.number === number);
		return place ? [place] : [];
	});
	const shape = islandFor(
		world.bounds.maxX - world.bounds.minX,
		world.bounds.maxZ - world.bounds.minZ,
		2.4
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
				<SeasonDiorama
					activeNumber={null}
					actors={{
						doorOf: new Map(
							stations.map((station) => [station.agentId, station.number])
						),
						iconOnly: budget.iconOnly,
						paths,
						props: (
							<SeasonActProps
								acts={acts}
								clock={FIXTURE_CLOCK}
								iconOnly={budget.iconOnly}
								nowMs={FIXTURE_NOW}
								offStage={offStage}
								onAsk={(askId) => asked.push(askId)}
								onBlocker={() => undefined}
								onQueue={() => undefined}
								onStage={onStage}
								owners={askOwners(acts)}
								reduced
								season={season}
								shown={shown}
								slots={slots}
								snapshot={snapshot}
								stations={stations}
								stopped={stopped}
							/>
						),
						villagers,
					}}
					doors={board.doors}
					giftId="gift"
					giftNumber={null}
					labelOf={(door) => doorLabel(door, SEASON_COPY[season])}
					looks={looks}
					night={season === "halloween"}
					onActivate={(number) => activated.push(number)}
					onKeyDown={() => undefined}
					quality="high"
					reducedMotion
					season={season}
					shape={shape}
					theme={GAME3D_NIGHT}
					today={null}
					world={world}
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
	return {
		acts,
		activated,
		asked,
		board,
		container,
		dispose,
		snapshot,
		stations,
		villagers,
	};
}

/** The fixture's exempt act targets, by kind (spec 7.2 test 21). */
const EXPECTED = { alarm: 3, notice: 1, suggestion: 1, tray: 1, unread: 1 };

function plateOf(container: HTMLElement, agentId: string) {
	const plate = container.querySelector<HTMLButtonElement>(
		`button[data-act-agent="${agentId}"]`
	);
	if (!plate) {
		throw new Error(`no plate for ${agentId}`);
	}
	return plate;
}

describe("seasonal act plates, rendered (test 21)", () => {
	for (const season of ["advent", "halloween", "lunar-new-year"] as const) {
		for (const width of [1280, 390]) {
			test(`${season}: every exempt target is a focusable, named control at ${width}`, () => {
				const { acts, container, dispose } = renderBoard(season, width);
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
					expect(alarms.sort()).toEqual(
						[
							"Di stopped: Tests failed, 20 minutes ago.",
							"Di stopped: Nightly backup failed, 6 hours ago.",
							"Ed stopped: Interrupted, about 1 hour ago.",
						].sort()
					);
					// One plate per agent, named by its act, in the Tab order.
					const plates = [
						...container.querySelectorAll<HTMLButtonElement>(
							"button[data-act-agent]"
						),
					];
					expect(plates).toHaveLength(acts.size);
					for (const plate of plates) {
						const agent = acts.get(plate.getAttribute("data-act-agent") ?? "");
						expect(plate.tabIndex).toBe(0);
						expect(plate.getAttribute("aria-label")).toStartWith(
							agent?.ariaLabel ?? "(none)"
						);
					}
					const budgeted = container.querySelectorAll(
						"[data-budgeted-overlay]"
					);
					expect(budgeted.length).toBeLessThanOrEqual(narrow ? 8 : 16);
				} finally {
					dispose();
				}
			});
		}
	}

	test("villager plates: Ada's opens her ask; Cy's opens his door (15a)", () => {
		const { activated, asked, board, container, dispose } = renderBoard(
			"halloween",
			1280
		);
		try {
			const ada = plateOf(container, FIXTURE_AGENT_IDS.ada);
			expect(ada.hasAttribute("aria-pressed")).toBe(false);
			expect(ada.getAttribute("aria-label")).toEndWith("Answer their ask.");
			act(() => ada.click());
			expect(asked).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
			expect(activated).toEqual([]);
			const cy = plateOf(container, FIXTURE_AGENT_IDS.cy);
			expect(cy.getAttribute("aria-pressed")).toBe("false");
			expect(cy.getAttribute("aria-label")).toEndWith(
				"Open their conversation."
			);
			act(() => cy.click());
			const cyDoor = board.doors.find(
				(door) => door.thread?.id === FIXTURE_THREAD_IDS.cy
			)?.number;
			expect(activated).toEqual([cyDoor ?? -1]);
			expect(asked).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		} finally {
			dispose();
		}
	});
});

describe("seasonal extras (s12)", () => {
	for (const season of ["advent", "halloween", "lunar-new-year"] as const) {
		test(`${season}: the wait timers are candles on the season's dish`, () => {
			timerProps.length = 0;
			const { dispose } = renderBoard(season, 1280);
			try {
				// The queue's timers wear the skin (the kit's other timers, a
				// stalled cue or a notice's, keep the hourglass).
				const queued = timerProps.filter(
					(props) => props.color === SEASON_ACT_ART[season].timer
				);
				expect(queued.length).toBeGreaterThan(0);
				for (const props of queued) {
					expect(props.shape).toBe("candle");
				}
			} finally {
				dispose();
			}
		});

		test(`${season}: the delivered gift carries its headline tag, never redacted`, () => {
			const tags = (privacy: "full" | "redacted") => {
				const { container, dispose } = renderBoard(season, 1280, privacy);
				try {
					expect(
						container.querySelectorAll('[data-you-spot="tray"]').length
					).toBe(1);
					return [...container.querySelectorAll("[data-tray-tag]")].map(
						(tag) => tag.textContent
					);
				} finally {
					dispose();
				}
			};
			expect(tags("full")).toEqual(["Edited 3 files"]);
			expect(tags("redacted")).toEqual([]);
		});

		test(`${season}: helpers wear the season's dress`, () => {
			const { dispose, villagers } = renderBoard(season, 1280);
			dispose();
			const helpers = villagers.filter((spec) => spec.id.includes(":helper:"));
			expect(helpers.length).toBeGreaterThan(0);
			const dress = seasonHelperDress(season);
			expect(dress.accessory).toBeDefined();
			expect(dress.body).toBe(SEASON_ACT_ART[season].elfBody);
			for (const helper of helpers) {
				expect(helper.looks).toMatchObject(dress);
			}
		});

		test(`${season}: tomorrow's door stands only for a scheduled run`, () => {
			const { acts, container, dispose, snapshot, stations } = renderBoard(
				season,
				1280
			);
			try {
				const withRun = stations.filter((station) =>
					nextRunOf(station.agentId, snapshot, FIXTURE_NOW, FIXTURE_CLOCK)
				);
				// Cy has a 09:00 run, though his next words name a plan step.
				expect(withRun.map((station) => station.agentId)).toContain(
					FIXTURE_AGENT_IDS.cy
				);
				expect(acts.get(FIXTURE_AGENT_IDS.cy)?.next).toBe("Next: write tests");
				expect(
					container.querySelectorAll('group[name="tomorrow-door"]').length
				).toBe(withRun.length);
			} finally {
				dispose();
			}
			const render = seasonNext(season);
			const at = [0, 0, 0] as [number, number, number];
			const run = { label: "tomorrow 09:00", start: "2026-10-20T09:00:00Z" };
			expect(render({ at, run, text: "Next: write tests" })).toMatchObject({
				type: TomorrowDoor,
			});
			// A plan step alone keeps the kit's sign; no door.
			expect(
				render({ at, run: null, text: "Next: write tests" })
			).toMatchObject({ type: NextSign });
		});
	}
});
