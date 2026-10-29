import "./planets-test-dom.ts";
import { afterAll, describe, expect, mock, test } from "bun:test";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement, ReactNode } from "react";
import { planetsDom } from "./planets-test-dom.ts";

// Again here: another Planets test file may have taken the DOM down.
planetsDom();

// The act layer's plates are drei `Html` plates over three.js meshes;
// outside a Canvas, render the plates in place and give the frame hooks a
// stand-in. Each mock spreads the real module, so a later test file in the
// same run still finds every export.
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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { actOverlays, overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { limitWords } = await import("./game3d-act-stage.tsx");
const { YOU_SPOT_GAP } = await import("./game3d-plates.ts");
const { askOwners } = await import("./interface-ask-card.tsx");
const {
	arcSpans,
	boardBeside,
	boardLift,
	boardSize,
	PlanetsActLayer,
	planetsLimitText,
	probePlace,
	STATION_UNIT_PX,
	stationLayout,
} = await import("./planets-acts.tsx");
const { buildSystem, holdOrbits, OVERVIEW_AZIMUTH } = await import(
	"./planets-model.ts"
);
const { PlanetsInterface } = await import("./planets-interface.tsx");
const { ActClockProvider } = await import("./use-acts.ts");

afterAll(() => {
	mock.restore();
});

const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const unowned = unownedAsks(fixture);
const slots = youSpotSlots(acts, unowned);
const staged = stageAgents(acts, Number.POSITIVE_INFINITY);

function mountQuiet(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() => root.render(element));
	} finally {
		console.error = errors;
	}
	return {
		container,
		dispose: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/**
 * The act layer exactly as PlanetsInterface hands it to the scene at a
 * 1280 or a 390 stage (its overlay budget and station layout), rendered
 * as the kit's plates.
 */
function renderLayer(width: number) {
	const budget = overlayBudget(width, { domTargets: false });
	const shown = new Set(
		budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((item) => item.act === "working")?.agentId ?? null,
				{ reduced: true }
			)
		)
	);
	const asked: string[] = [];
	const stopped: string[] = [];
	const sim = {
		current: {
			bodyScale: 1,
			moonGroups: new Map(),
			positions: new Map(),
			time: 0,
		},
	};
	const view = mountQuiet(
		<PlanetsActLayer
			azimuth={OVERVIEW_AZIMUTH}
			reduced
			sim={sim}
			system={holdOrbits(buildSystem(fixture, acts))}
			view={{
				acts,
				clock: FIXTURE_CLOCK,
				iconOnly: budget.iconOnly,
				nowMs: FIXTURE_NOW,
				offStage: staged.offStage,
				onAsk: (askId) => asked.push(askId),
				onBlocker: (threadId) => stopped.push(threadId),
				onQueue: () => undefined,
				onStage: staged.onStage,
				owners: askOwners(acts),
				privacy: "full",
				shown,
				slots,
				snapshot: fixture,
				width,
			}}
		/>
	);
	return { ...view, asked, stopped };
}

const EXPECTED = { alarm: 3, notice: 1, suggestion: 1, tray: 1, unread: 1 };
const named = (name: string) => {
	const found = [...acts.values()].find((item) => item.agentName === name);
	if (!found) {
		throw new Error(name);
	}
	return found;
};

describe("planets station and planet signs (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`every exempt target is a named pointer plate, icon-only at 390 but the notice (${width})`, () => {
			const { container, dispose } = renderLayer(width);
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
						// A list game: the scene's openers are pointer targets; the
						// ask queue and the planet list carry the keyboard.
						expect(target.tabIndex).toBe(-1);
						expect(target.getAttribute("aria-hidden")).toBe("true");
						expect(target.getAttribute("aria-label")?.length).toBeGreaterThan(
							10
						);
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
				// The docked probes: Bo and Ada, each a queue plate with its wait.
				const probes = [
					...container.querySelectorAll<HTMLButtonElement>(
						"button[data-act-agent][data-you-spot='slot']"
					),
				];
				expect(probes.map((probe) => probe.dataset.actAgent)).toEqual([
					named("Bo").agentId,
					named("Ada").agentId,
				]);
				for (const probe of probes) {
					const asking = acts.get(probe.dataset.actAgent ?? "");
					expect(probe.tabIndex).toBe(-1);
					expect(probe.getAttribute("aria-label")).toBe(
						`${asking?.ariaLabel} Answer their ask.`
					);
					expect(probe.hasAttribute("aria-pressed")).toBe(false);
					expect(probe.textContent).toContain(" · ");
					// Each kind's satellite icon rides on its plate.
					expect(probe.querySelector("svg")).not.toBeNull();
				}
				expect(container.textContent).toContain("Back 15:10");
				expect(
					container.querySelectorAll("[data-budgeted-overlay]").length
				).toBeLessThanOrEqual(narrow ? 8 : 16);
			} finally {
				dispose();
			}
		});
	}

	test("15a: a docked probe's plate opens its ask", () => {
		const { asked, container, dispose } = renderLayer(1280);
		try {
			const ada = container.querySelector<HTMLButtonElement>(
				`button[data-act-agent="${named("Ada").agentId}"]`
			);
			act(() => ada?.click());
			expect(asked).toEqual([named("Ada").ask?.id ?? "missing"]);
		} finally {
			dispose();
		}
	});
});

describe("planets act model", () => {
	test("probes launch to their berths; answers go to the cargo bay", () => {
		expect(probePlace(named("Bo"), slots.slots, true)).toBe("you-1");
		expect(probePlace(named("Ada"), slots.slots, true)).toBe("you-3");
		expect(probePlace(named("Gu"), slots.slots, false)).toBe("tray");
		expect(probePlace(named("Cy"), slots.slots, true)).toBe("home");
	});

	test("the eclipse reads Back 15:10", () => {
		expect(
			limitWords(named("Fa"), {
				clock: FIXTURE_CLOCK,
				limitText: planetsLimitText,
				nowMs: FIXTURE_NOW,
			})
		).toBe("Back 15:10");
	});

	test("berths stand a plate and a gap apart, two by two on a phone", () => {
		const plate = 96;
		for (const width of [1280, 390]) {
			const { berths } = stationLayout(width);
			const points = Object.values(berths);
			for (const [index, a] of points.entries()) {
				for (const b of points.slice(index + 1)) {
					const dx = Math.abs(a[0] - b[0]) * STATION_UNIT_PX;
					const dy = Math.abs(a[1] - b[1]) * STATION_UNIT_PX;
					expect(dx >= plate + YOU_SPOT_GAP || dy >= 28 + YOU_SPOT_GAP).toBe(
						true
					);
				}
			}
			const rows = new Set(points.map((point) => point[1]));
			expect(rows.size).toBe(width < 640 ? 2 : 1);
		}
	});

	test("a board stands clear of its world and of its arc only where they meet", () => {
		const size = boardSize([
			{ text: "3/7" },
			{ text: "12m" },
			{ text: "Next: write tests" },
		]);
		expect(size.height).toBe(78);
		const planetPx = 20;
		const bottom = (lift: number) => lift * planetPx - size.height / 2;
		// No arc: just clear of the world (and never under the usual lift).
		const bare = boardLift({ arcs: [], planetPx, size });
		expect(bottom(bare)).toBeGreaterThan(planetPx);
		expect(bottom(bare - 0.25)).toBeLessThan(planetPx + 6);
		expect(boardLift({ arcs: [], planetPx: 400, size })).toBe(1.75);
		// An arc right over the world lifts the board past its top.
		const over = { bottom: 10, left: -20, right: 20, top: 70 };
		expect(bottom(boardLift({ arcs: [over], planetPx, size }))).toBeGreaterThan(
			70
		);
		// The same arc far off to the side leaves it alone.
		const aside = { ...over, left: 200, right: 240 };
		expect(boardLift({ arcs: [aside], planetPx, size })).toBe(bare);
	});

	test("a phone's board stands beside its world, past its arc, inside the scene", () => {
		const size = { height: 78, width: 130 };
		const planetPx = 24;
		const left = (right: number) => right * planetPx - size.width / 2;
		// Clear of the world (and of its alarms).
		expect(
			left(boardBeside({ alarms: false, arcs: [], planetPx, room: 400, size }))
		).toBeGreaterThan(planetPx);
		expect(
			left(boardBeside({ alarms: true, arcs: [], planetPx, room: 400, size }))
		).toBeGreaterThan(1.45 * planetPx + 18);
		// Past an arc level with it.
		const arc = { bottom: -10, left: 10, right: 60, top: 30 };
		expect(
			left(
				boardBeside({ alarms: false, arcs: [arc], planetPx, room: 400, size })
			)
		).toBeGreaterThan(60);
		// Short of room it keeps to the scene, still past the world.
		const tight = boardBeside({
			alarms: false,
			arcs: [arc],
			planetPx,
			room: 170,
			size,
		});
		expect(left(tight)).toBeGreaterThan(planetPx);
		expect(left(tight)).toBeLessThan(60);
	});

	test("a moon's arc is watched where it stands now and a little ahead", () => {
		const moon = { orbit: 2, radius: 0.4, shell: 0 };
		const spans = arcSpans({
			moon,
			// On the near side, at the front of its ring.
			offset: [2, 0, 0],
			perPx: 0.1,
			pips: 7,
			right: [1, 0, 0],
			scale: 1,
			up: [0, 0, -1],
		});
		// The moon and its seven pips, now and at each moment ahead.
		expect(spans.length % 8).toBe(0);
		expect(spans.length).toBeGreaterThan(8);
		// Now: the moon level with the world's centre, to its right, its
		// pips over it.
		const [now, ...pips] = spans;
		expect(now && (now.left + now.right) / 2).toBeCloseTo(20, 5);
		expect(now && (now.top + now.bottom) / 2).toBeCloseTo(0, 5);
		for (const pip of pips.slice(0, 7)) {
			expect(pip.bottom).toBeGreaterThan(0);
		}
		// Held still, it is only where it stands.
		expect(
			arcSpans({
				horizon: 0,
				moon,
				offset: [2, 0, 0],
				perPx: 0.1,
				pips: 7,
				right: [1, 0, 0],
				scale: 1,
				up: [0, 0, -1],
			})
		).toHaveLength(8);
	});

	test("a phone's berths stand in a strip down the left, clear of the column", () => {
		const width = 390;
		const { anchor, berths, layout } = stationLayout(width, true);
		const points = Object.values(berths);
		// One above another, a plate and a ring apart.
		expect(new Set(points.map((point) => point[0])).size).toBe(1);
		const ys = points.map((point) => point[1] * STATION_UNIT_PX);
		for (const [index, y] of ys.entries()) {
			const next = ys[index + 1];
			if (next !== undefined) {
				expect(y - next).toBeGreaterThanOrEqual(28 + 50 + YOU_SPOT_GAP);
			}
		}
		// A queue plate (about 100px wide) stays left of the column's worlds.
		const centre = width - anchor[0];
		expect(centre - 50).toBeGreaterThanOrEqual(8);
		expect(centre + 50).toBeLessThanOrEqual(130);
		// The cargo bay sits below the last berth, the tallies above the first.
		expect(layout.tray[1]).toBeLessThan(Math.min(...points.map((p) => p[1])));
		expect(layout.tally[1]).toBeGreaterThan(
			Math.max(...points.map((p) => p[1]))
		);
	});

	test("moons go by act priority: the act's thread is the first moon", () => {
		const system = buildSystem(fixture, acts);
		for (const planet of system.planets) {
			const threadId = acts.get(planet.id)?.threadId;
			if (threadId && planet.moons.some((moon) => moon.threadId === threadId)) {
				expect(planet.moons[0]?.threadId).toBe(threadId);
			}
		}
		// Without acts the moons keep their urgency order.
		expect(buildSystem(fixture).planets.map((planet) => planet.id)).toEqual(
			system.planets.map((planet) => planet.id)
		);
	});

	test("with acts every planet holds its place", () => {
		const held = holdOrbits(buildSystem(fixture, acts));
		expect(held.planets.every((planet) => planet.orbitSpeed === 0)).toBe(true);
	});
});

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function planets(snapshot: InterfaceSnapshot) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={null}
			/>
		</ActClockProvider>
	);
}

async function flush(ms = 40) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

const rows = (container: HTMLElement) => [
	...container.querySelectorAll<HTMLButtonElement>(
		"[aria-label='Bodies in orbit, innermost first'] [data-act-agent]"
	),
];

describe("planets useful state (list game)", () => {
	test("21: every planet row is a Tab stop named by its act; the queue and summary show", async () => {
		const view = mountQuiet(planets(fixture));
		await flush();
		try {
			const listed = rows(view.container);
			expect(listed.map((row) => row.dataset.actAgent).sort()).toEqual(
				[...acts.keys()].sort()
			);
			for (const row of listed) {
				const rowAct = acts.get(row.dataset.actAgent ?? "");
				expect(row.tabIndex).toBe(0);
				expect(row.getAttribute("aria-label")).toBe(
					rowAct?.act === "asking"
						? `${rowAct.ariaLabel} Answer their ask.`
						: `${rowAct?.ariaLabel} Visit their planet.`
				);
			}
			const queue = view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			);
			expect(queue).toHaveLength(9);
			const summary = "3 need you · 2 working · 1 failed · 1 limited";
			expect(
				view.container.querySelector("[data-act-summary]")?.textContent
			).toBe(summary);
			expect(
				view.container
					.querySelector("[role='application']")
					?.getAttribute("aria-label")
			).toBe(
				`Solar system: ${summary}. Arrow keys visit planets, plus and minus zoom.`
			);
			expect(
				view.container.querySelector("[data-queue-button]")?.textContent
			).toBe("Queue · 9");
			expect(view.container.querySelector("[data-blind-spot]")).not.toBeNull();
			// The no-WebGL note stays.
			expect(view.container.textContent).toContain(
				"The 3D view needs WebGL, which is off here."
			);
		} finally {
			view.dispose();
		}
	});

	test("15a: Ada's row opens her ask; Cy's visits his planet", async () => {
		const view = mountQuiet(planets(fixture));
		await flush();
		try {
			const row = (name: string) =>
				rows(view.container).find(
					(item) => item.dataset.actAgent === named(name).agentId
				);
			const ada = row("Ada");
			expect(ada?.hasAttribute("aria-current")).toBe(false);
			act(() => ada?.click());
			await flush();
			expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
				"Can I run shell.run now?"
			);
			const close = [
				...document.querySelectorAll("[data-ask-card] button"),
			].find((button) => button.textContent === "Close");
			act(() => (close as HTMLButtonElement | undefined)?.click());
			await flush(80);
			act(() => row("Cy")?.click());
			await flush();
			expect(row("Cy")?.getAttribute("aria-current")).toBe("true");
			expect(view.container.textContent).toContain("Visiting Cy");
		} finally {
			view.dispose();
		}
	});
});
