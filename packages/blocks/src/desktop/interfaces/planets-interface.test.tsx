import "./planets-test-dom.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { resolveInterfaceParams } from "@ryuhq/protocol/interfaces";
import { usefulStateFixture } from "@ryuhq/protocol/interfaces-fixture";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanetsInterface, planetsSettings } from "./planets-interface.tsx";
import {
	buildSystem,
	cyclePlanet,
	EMPTY_HUD,
	FOV,
	focusFrame,
	freeRegions,
	type HudLayout,
	hashId,
	MAX_MOONS,
	moonOffset,
	moonsFor,
	ORBIT_PACE,
	orbitOrder,
	overviewElevation,
	overviewFrame,
	overviewReach,
	overviewSketch,
	PLANET_KINDS,
	planetKind,
	planetRadius,
	planetVariant,
	sectionThreads,
	systemSummary,
	threadsWaitingOnYou,
} from "./planets-model.ts";
import { createOverlayRegistry, PlanetsOverlay } from "./planets-overlay.tsx";
import {
	EMPTY_THEME,
	PLANET_LOOKS,
	planetLookIn,
	planetLooks,
	planetsPalette,
	statusColorsClash,
} from "./planets-palette.ts";
import { moonSides, placeLabel } from "./planets-placement.ts";
import { planetsDom } from "./planets-test-dom.ts";
import { planetPose } from "./planets-world.tsx";

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
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Same thread count as Ada",
			id: "agent-babbage",
			name: "Babbage",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-core",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Core",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-linus"],
			name: "Site",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			running: true,
			title: "Flaky test",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-crash",
			runState: "failed",
			title: "Crash triage",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-grace", "agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: ["agent-babbage"],
			id: "thread-engine",
			lastMessageRole: "user",
			title: "Difference engine",
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			title: "Office closed Friday",
		}),
	],
	version: 1,
};

// Again here: another Planets test file may have taken the DOM down.
planetsDom();

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

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
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

describe("planets model", () => {
	test("busier agents orbit closer; ties go by name", () => {
		const counts = new Map([
			["agent-ada", 1],
			["agent-babbage", 1],
			["agent-grace", 3],
			["agent-linus", 0],
		]);
		expect(
			orbitOrder(SNAPSHOT.agents, counts).map((agent) => agent.name)
		).toEqual(["Grace", "Ada", "Babbage", "Linus"]);
		const system = buildSystem(SNAPSHOT);
		expect(system.planets.map((planet) => planet.name)).toEqual([
			"Grace",
			"Ada",
			"Babbage",
			"Linus",
		]);
		const radii = system.planets.map((planet) => planet.orbitRadius);
		expect(radii).toEqual([...radii].sort((a, b) => a - b));
		// Orbits never overlap: each one clears its neighbour's moons.
		for (const [index, planet] of system.planets.entries()) {
			const next = system.planets[index + 1];
			if (next) {
				expect(next.orbitRadius - planet.orbitRadius).toBeGreaterThan(
					planet.extent + next.extent
				);
			}
		}
		expect(system.systemRadius).toBeGreaterThan(
			(system.planets.at(-1)?.orbitRadius ?? 0) + 1
		);
	});

	test("a planet's look comes from its id alone, and its size from its threads", () => {
		const ids = Array.from({ length: 60 }, (_, index) => `agent-${index}`);
		for (const id of ids) {
			expect(planetKind(id)).toBe(planetKind(id));
			expect(PLANET_KINDS).toContain(planetKind(id));
			expect(planetVariant(id, 3)).toBe(planetVariant(id, 3));
			expect(planetVariant(id, 3)).toBeLessThan(3);
		}
		// Every kind turns up across a spread of ids.
		expect(new Set(ids.map(planetKind)).size).toBe(PLANET_KINDS.length);
		expect(hashId("agent-ada")).not.toBe(hashId("agent-grace"));
		for (const kind of PLANET_KINDS) {
			expect(PLANET_LOOKS[kind].length).toBeGreaterThan(1);
		}
		expect(planetRadius(0)).toBeLessThan(planetRadius(1));
		expect(planetRadius(1)).toBeLessThan(planetRadius(4));
		expect(planetRadius(500)).toBe(planetRadius(25));
		// The busiest planet reads clearly bigger, beyond what perspective does.
		expect(planetRadius(3) / planetRadius(1)).toBeGreaterThan(1.25);
		const system = buildSystem(SNAPSHOT);
		const grace = system.planets.find((planet) => planet.id === "agent-grace");
		const linus = system.planets.find((planet) => planet.id === "agent-linus");
		expect(grace?.radius).toBeGreaterThan(linus?.radius ?? 0);
		expect(grace?.kind).toBe(planetKind("agent-grace"));
	});

	test("moons are threads by urgency, capped at eight with a +N overflow", () => {
		const many = Array.from({ length: 11 }, (_, index) =>
			thread({
				agentIds: ["agent-ada"],
				id: `thread-${index}`,
				lastMessageRole: "user",
				updatedAt: ago(index),
			})
		);
		many.push(
			thread({
				agentIds: ["agent-ada"],
				id: "thread-failed",
				runState: "failed",
			})
		);
		const { moons, overflow } = moonsFor(many, 1, "agent-ada");
		expect(moons).toHaveLength(MAX_MOONS);
		expect(overflow).toBe(many.length - MAX_MOONS);
		// The failed run is the most urgent, so it is always drawn.
		expect(moons[0]?.threadId).toBe("thread-failed");
		expect(moons[0]?.status).toBe("attention");
		// Moons alternate between two shells, so neighbours never collide.
		expect(new Set(moons.map((moon) => moon.shell))).toEqual(new Set([0, 1]));
		const inner = moons.filter((moon) => moon.shell === 0);
		expect(new Set(inner.map((moon) => moon.phase)).size).toBe(inner.length);
		const [x, y, z] = moonOffset(
			moons[0] ?? { orbit: 1, phase: 0, shell: 0 },
			0
		);
		expect(Math.hypot(x, y, z)).toBeCloseTo(moons[0]?.orbit ?? 0, 5);

		const system = buildSystem({
			...SNAPSHOT,
			threads: [...SNAPSHOT.threads, ...many],
		});
		const ada = system.planets.find((planet) => planet.id === "agent-ada");
		expect(ada?.moons).toHaveLength(MAX_MOONS);
		expect(ada?.overflow).toBe(13 - MAX_MOONS);
	});

	test("moon status follows threadStatus; loose threads orbit the star", () => {
		const system = buildSystem(SNAPSHOT);
		const grace = system.planets.find((planet) => planet.id === "agent-grace");
		const statuses = Object.fromEntries(
			(grace?.moons ?? []).map((moon) => [moon.threadId, moon.status])
		);
		expect(statuses).toEqual({
			"thread-crash": "attention",
			"thread-flaky": "working",
			"thread-notes": "your-turn",
		});
		expect(grace?.working).toBe(true);
		expect(grace?.teamId).toBe("team-core");
		// A shared thread is a moon of every planet on it.
		const ada = system.planets.find((planet) => planet.id === "agent-ada");
		expect(ada?.moons.map((moon) => moon.threadId)).toEqual(["thread-notes"]);
		// Teams only: projects are not teams.
		expect(system.teams.map((team) => team.name)).toEqual(["Core"]);
		expect(system.starMoons.map((moon) => moon.threadId)).toEqual([
			"thread-loose",
		]);
		expect(system.unassigned.map((item) => item.id)).toEqual(["thread-loose"]);
		expect(systemSummary(SNAPSHOT)).toEqual({
			agents: 4,
			attention: 1,
			threads: 5,
			unassigned: 1,
			waitingOnYou: 2,
			working: 1,
			yourTurn: 1,
		});
		expect(threadsWaitingOnYou(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-crash",
			"thread-notes",
		]);
		expect(
			sectionThreads(SNAPSHOT.threads).map((section) => section.status)
		).toEqual(["attention", "your-turn", "working", "waiting"]);
	});

	test("arrow keys cycle planets in orbit order and wrap", () => {
		const planets = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(cyclePlanet(planets, null, 1)).toBe("a");
		expect(cyclePlanet(planets, null, -1)).toBe("c");
		expect(cyclePlanet(planets, "c", 1)).toBe("a");
		expect(cyclePlanet(planets, "a", -1)).toBe("c");
		expect(cyclePlanet([], null, 1)).toBe(null);
	});

	test("the overview fits the system in the room the HUD leaves", () => {
		const viewport = { height: 900, width: 1440 };
		const open: HudLayout = {
			card: { bottom: 470, left: 16, right: 284, top: 16 },
			controls: { bottom: 52, left: 1200, right: 1424, top: 16 },
			legend: { bottom: 884, left: 16, right: 546, top: 794 },
		};
		const wide = overviewFrame(40, viewport, 40, 0.68, open);
		const plain = overviewFrame(40, viewport, 40, 0.68, EMPTY_HUD);
		// Clear of the card: the picture slides right.
		expect(wide.shiftX).toBeGreaterThan(100);
		expect(plain.shiftX).toBe(0);
		expect(wide.distance).toBeGreaterThanOrEqual(plain.distance);
		const narrow = overviewFrame(40, { height: 900, width: 390 }, 40, 0.68);
		expect(narrow.distance).toBeGreaterThan(plain.distance);
	});

	test("a folded card frames the system below it, not beside it", () => {
		const viewport = { height: 775, width: 900 };
		const folded: HudLayout = {
			card: { bottom: 146, left: 16, right: 284, top: 16 },
			controls: { bottom: 52, left: 660, right: 884, top: 16 },
			legend: { bottom: 759, left: 16, right: 546, top: 695 },
		};
		expect(freeRegions(folded, viewport)).toHaveLength(2);
		const frame = overviewFrame(40, viewport, 40, 0.68, folded);
		// Folding frees room: closer than fitting beside the card.
		const beside = overviewFrame(40, viewport, 40, 0.68, {
			...folded,
			card: { bottom: 700, left: 16, right: 284, top: 16 },
		});
		expect(frame.distance).toBeLessThan(beside.distance);
	});

	test("the overview tucks the system's empty corners beside the HUD, never under it", () => {
		const viewport = { height: 775, width: 900 };
		const layout: HudLayout = {
			card: { bottom: 470, left: 16, right: 283, top: 16 },
			controls: { bottom: 50, left: 663, right: 884, top: 16 },
			legend: { bottom: 758, left: 16, right: 546, top: 693 },
		};
		const system = buildSystem(SNAPSHOT);
		const sketch = overviewSketch(system, viewport, layout);
		const points = sketch.orbits.flatMap((path) =>
			path
				.replace(/[MZ]/g, "")
				.split("L")
				.map((point) => point.split(" ").map(Number))
		);
		const inside = (box: NonNullable<HudLayout["card"]>, x = 0, y = 0) =>
			x > box.left && x < box.right && y > box.top && y < box.bottom;
		for (const [x, y] of points) {
			for (const box of [layout.card, layout.controls, layout.legend]) {
				if (box) {
					expect(inside(box, x, y)).toBe(false);
				}
			}
			expect(x).toBeGreaterThan(0);
			expect(x).toBeLessThan(viewport.width);
		}
		// Closer than fitting the whole system into the strip beside the card.
		const reach = overviewReach(system);
		const elevation = overviewElevation(viewport.width, viewport.height);
		const tucked = overviewFrame(reach, viewport, FOV, elevation, layout);
		const strip = overviewFrame(reach, viewport, FOV, elevation, {
			...layout,
			card: { ...layout.card, bottom: 760 } as HudLayout["card"],
		});
		expect(tucked.distance).toBeLessThanOrEqual(strip.distance);
	});

	test("the loading sketch projects the star and orbits where the scene draws them", () => {
		const viewport = { height: 875, width: 1440 };
		const layout: HudLayout = {
			card: { bottom: 470, left: 16, right: 283, top: 16 },
			controls: { bottom: 52, left: 1203, right: 1424, top: 16 },
			legend: { bottom: 858, left: 16, right: 546, top: 793 },
		};
		const system = buildSystem(SNAPSHOT);
		const sketch = overviewSketch(system, viewport, layout);
		const frame = overviewFrame(
			overviewReach(system),
			viewport,
			FOV,
			overviewElevation(viewport.width, viewport.height),
			layout
		);
		expect(sketch.centre.x).toBeCloseTo(viewport.width / 2 + frame.shiftX, 3);
		expect(sketch.orbits).toHaveLength(system.planets.length);
		const ys = (sketch.orbits.at(-1) ?? "")
			.replace(/[MZ]/g, "")
			.split("L")
			.map((point) => Number(point.split(" ")[1]));
		const top = Math.min(...ys);
		const bottom = Math.max(...ys);
		// Perspective: the near side of an orbit hangs further below the star
		// than the far side rises above it, and it all stays above the legend.
		expect(bottom - sketch.centre.y).toBeGreaterThan(sketch.centre.y - top);
		expect(top).toBeGreaterThan(layout.controls?.bottom ?? 0);
		expect(bottom).toBeLessThan(layout.legend?.top ?? viewport.height);
	});

	test("a visited planet is centred in the free region", () => {
		const viewport = { height: 900, width: 1056 };
		const layout: HudLayout = {
			card: { bottom: 146, left: 16, right: 284, top: 16 },
			controls: null,
			legend: { bottom: 884, left: 16, right: 546, top: 794 },
		};
		const limits = { margin: 1.5, minDistance: 8, minExtents: 3.2 };
		const fit = focusFrame(3, viewport, 40, layout, limits);
		expect(fit.shiftX).toBe((fit.region.left - fit.region.right) / 2);
		expect(fit.distance).toBeGreaterThanOrEqual(9.6);
		const tight = focusFrame(
			3,
			{ height: 500, width: 390 },
			40,
			layout,
			limits
		);
		expect(tight.distance).toBeGreaterThan(fit.distance);
	});

	test("labels take a clear side and stay inside the scene", () => {
		const bounds = { bottom: 892, left: 8, right: 1432, top: 8 };
		const size = { height: 22, width: 90 };
		const anchor = { radius: 10, x: 400, y: 300 };
		const free = placeLabel({
			anchor,
			bounds,
			obstacles: [],
			sides: ["below", "above"],
			size,
		});
		expect(free.side).toBe("below");
		expect(free.box.top).toBe(316);
		// Something under the body: the plate flips above it.
		const blocked = placeLabel({
			anchor,
			bounds,
			obstacles: [{ bottom: 360, left: 340, right: 460, top: 312 }],
			sides: ["below", "above"],
			size,
		});
		expect(blocked.side).toBe("above");
		expect(blocked.overlap).toBe(0);
		// Once the way is clear again it goes home, below its body.
		const home = placeLabel({
			anchor,
			bounds,
			obstacles: [],
			previous: "above",
			sides: ["below", "above"],
			size,
		});
		expect(home.side).toBe("below");
		// At the right edge it slides back in rather than being cut off.
		const edge = placeLabel({
			anchor: { radius: 6, x: 1430, y: 300 },
			bounds,
			obstacles: [],
			sides: ["below"],
			size,
		});
		expect(edge.box.right).toBeLessThanOrEqual(1432);
		// A moon in its planet's upper half labels upward, away from the planet.
		const planet = { radius: 60, x: 500, y: 400 };
		expect(moonSides({ radius: 4, x: 510, y: 330 }, planet)[0]).toBe("above");
		expect(moonSides({ radius: 4, x: 510, y: 470 }, planet)[0]).toBe("below");
		expect(moonSides({ radius: 4, x: 590, y: 405 }, planet)[0]).toBe("right");
	});

	test("the palette follows the theme: deep space for dark, a pale sky for light", () => {
		const dark = planetsPalette({
			...EMPTY_THEME,
			background: [10, 12, 20],
			destructive: [220, 40, 40],
			primary: [0, 120, 255],
		});
		expect(dark.mode).toBe("dark");
		expect(dark.additive).toBe(true);
		expect(dark.status.attention).toEqual([220, 40, 40]);
		expect(dark.status["your-turn"]).toEqual([0, 120, 255]);
		const light = planetsPalette({
			...EMPTY_THEME,
			background: [250, 250, 250],
		});
		expect(light.mode).toBe("light");
		expect(light.additive).toBe(false);
		expect(light.night).toBeGreaterThan(dark.night);
		expect(planetsPalette({ ...EMPTY_THEME, darkClass: true }).mode).toBe(
			"dark"
		);
	});

	test("your turn never shares a color with working, even in a green theme", () => {
		const green = planetsPalette({
			...EMPTY_THEME,
			background: [255, 255, 255],
			destructive: [220, 38, 38],
			primary: [22, 163, 74],
			success: [22, 163, 74],
		});
		expect(green.status["your-turn"]).not.toEqual([22, 163, 74]);
		expect(
			statusColorsClash(green.status["your-turn"], green.status.working)
		).toBe(false);
		expect(
			statusColorsClash(green.status["your-turn"], green.status.attention)
		).toBe(false);
		// A grey accent would read as "waiting": it takes a hue too.
		const grey = planetsPalette({
			...EMPTY_THEME,
			background: [12, 12, 14],
			primary: [240, 240, 240],
			success: [60, 200, 120],
		});
		expect(statusColorsClash(grey.status["your-turn"], [128, 128, 128])).toBe(
			false
		);
		// Light themes get deeper team tints, so they hold on a pale sky.
		expect(green.teams[0]).not.toEqual(
			planetsPalette({ ...EMPTY_THEME, darkClass: true }).teams[0]
		);
	});
});

describe("planets toon worlds", () => {
	test("each planet wears its own agent's colour, the same everywhere", () => {
		const system = buildSystem(SNAPSHOT);
		const ids = system.planets.map((planet) => planet.id);
		const looks = planetLooks(ids);
		expect(looks.size).toBe(ids.length);
		const tones = new Set([...looks.values()].map((look) => look.a.join()));
		expect(tones.size).toBe(ids.length);
		for (const id of ids) {
			expect(planetLookIn(system, id)).toEqual(looks.get(id));
			const look = looks.get(id);
			// Bands: a lighter and a deeper tone of the same colour.
			const sum = (rgb: readonly number[]) =>
				rgb.reduce((total, value) => total + value, 0);
			expect(sum(look?.b ?? [])).toBeGreaterThan(sum(look?.a ?? []));
			expect(sum(look?.c ?? [])).toBeLessThan(sum(look?.a ?? []));
		}
	});

	test("the villager on top shows how its agent is doing", () => {
		const system = buildSystem(SNAPSHOT);
		for (const planet of system.planets) {
			const pose = planetPose(planet);
			if (planet.counts.attention > 0) {
				expect(pose).toBe("failed");
			} else if (planet.counts["your-turn"] > 0) {
				expect(pose).toBe("needs-you");
			} else {
				expect(pose).toBe(planet.working ? "working" : "idle");
			}
		}
	});
});

describe("planets interface", () => {
	test("renders the HUD, list and legend without a 3D context", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="interface-planets"');
		expect(markup).toContain('role="application"');
		expect(markup).toContain(
			"Solar system: you at the centre, 4 planets, 1 working, 2 waiting on you."
		);
		expect(markup).toContain('aria-label="Bodies in orbit, innermost first"');
		expect(markup).toContain(
			'aria-label="Grace, 3 threads, working, 2 waiting on you"'
		);
		expect(markup).toContain('aria-label="Legend"');
		expect(markup).toContain("Needs attention");
		expect(markup).toContain("Core");
		const text = markup.replaceAll(/<[^>]+>/g, " ");
		expect(text).toContain("Waiting on you");
		expect(text).toContain("Planets");
	});

	test("loading shows skeletons; an empty system invites a first thread", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			<PlanetsInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).toContain("Charting your system");
		const empty = renderToStaticMarkup(
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], groups: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(empty).toContain("No planets yet");
		expect(empty).toContain("Start a thread");
	});

	test("shows the host thread view in the panel beside the system", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PlanetsInterface
				activeThreadId="thread-crash"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="planets-panel"');
		expect(markup).toContain('data-view="thread"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
		expect(markup).toContain('aria-label="Back to Grace"');
		// Opened on a visited planet: no overview sketch under the close-up.
		expect(markup).toContain('data-testid="planets-placeholder"');
		expect(markup).not.toContain("stroke-foreground/15");
	});

	test("a planet opens its panel; threads and the composer act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			button(view.container, "Grace, 3 threads, working, 2 waiting on you")
		);
		const panel = view.container.querySelector('[data-testid="planets-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("planet");
		expect(panel?.textContent).toContain("Grace");
		expect(panel?.textContent).toContain("Triages bugs");
		expect(panel?.textContent).toContain("Core");

		await click(button(view.container, "Open Flaky test"));
		const field = panel?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		expect(panel?.querySelector("label")?.textContent).toBe("Message Grace");
		// An empty composer never sends.
		await typeInto(field, "   ");
		await press(field, "Enter");
		await typeInto(field, "  Retry the flaky test  ");
		await press(field, "Enter");
		await click(button(view.container, "New thread"));
		expect(calls).toEqual([
			"open:thread-flaky",
			'start:{"agentId":"agent-grace","prompt":"Retry the flaky test"}',
			"start:{}",
		]);

		// Escape (outside a text field) closes the panel.
		await press(panel?.querySelector("h2") ?? view.container, "Escape");
		expect(view.container.querySelector('[data-testid="planets-panel"]')).toBe(
			null
		);
		await view.dispose();
	});

	test("arrow keys in the scene visit planets; the list roves with arrows", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const scene = view.container.querySelector('[role="application"]');
		if (!scene) {
			throw new Error("No scene region");
		}
		await press(scene, "ArrowRight");
		let panel = view.container.querySelector('[data-testid="planets-panel"]');
		expect(panel?.getAttribute("aria-label")).toBe("Grace");
		await press(scene, "ArrowRight");
		panel = view.container.querySelector('[data-testid="planets-panel"]');
		expect(panel?.getAttribute("aria-label")).toBe("Ada");
		await press(scene, "ArrowLeft");
		await press(scene, "ArrowLeft");
		panel = view.container.querySelector('[data-testid="planets-panel"]');
		expect(panel?.getAttribute("aria-label")).toBe("Linus");

		const list = view.container.querySelector(
			'[aria-label="Bodies in orbit, innermost first"]'
		);
		const items = [...(list?.querySelectorAll("button") ?? [])];
		expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
		items[0]?.focus();
		await press(items[0] ?? scene, "ArrowDown");
		expect(document.activeElement).toBe(items[1] ?? null);
		await press(items[1] ?? scene, "End");
		expect(document.activeElement).toBe(items.at(-1) ?? null);

		// The star opens what is waiting on you and your own orbit.
		await click(items[0]);
		panel = view.container.querySelector('[data-testid="planets-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("star");
		expect(panel?.textContent).toContain("Waiting on you");
		expect(panel?.textContent).toContain("Office closed Friday");
		await view.dispose();
	});

	test("without asks the render is the one before the act layer", () => {
		// planets-legacy.golden.html: the renderer as it was before the act
		// layer, on the old snapshot. Ids and the kit's own stage attributes
		// (data-iso-*) are normalised away in both.
		const sansIds = (html: string) =>
			html
				.replace(/_[rR]_[0-9a-zA-Z]+_/g, "ID")
				.replace(/ data-iso-[a-z-]+="[^"]*"/g, "");
		const { asks: _asks, ...old } = usefulStateFixture();
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PlanetsInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={old as InterfaceSnapshot}
				threadView={null}
			/>
		);
		expect(markup).not.toContain("data-act-agent");
		expect(markup).not.toContain("data-ask-queue");
		expect(markup).not.toContain("data-queue-button");
		expect(sansIds(markup)).toBe(
			sansIds(
				readFileSync(
					join(import.meta.dir, "planets-legacy.golden.html"),
					"utf8"
				)
			)
		);
	});
});

describe("Planets settings", () => {
	test("default to normal orbits with moon labels; junk falls back", () => {
		expect(resolveInterfaceParams("planets", {})).toMatchObject({
			moonLabels: true,
			orbitSpeed: "normal",
		});
		expect(
			resolveInterfaceParams("planets", { moonLabels: "no", orbitSpeed: 3 })
		).toMatchObject({ moonLabels: true, orbitSpeed: "normal" });
		expect(
			planetsSettings({ moonLabels: false, orbitSpeed: "still" })
		).toMatchObject({ moonLabels: false, orbitSpeed: "still" });
	});

	test("orbit speed is a pace on the stock speed: normal unchanged, still holds", () => {
		expect(ORBIT_PACE.normal).toBe(1);
		expect(ORBIT_PACE.slow).toBeGreaterThan(0);
		expect(ORBIT_PACE.slow).toBeLessThan(1);
		expect(ORBIT_PACE.still).toBe(0);
	});

	test("moon labels pin the visited body's moon titles, or leave them to hover", () => {
		const system = buildSystem(usefulStateFixture());
		const overlay = (moonLabels?: boolean) =>
			renderToStaticMarkup(
				<PlanetsOverlay
					focusId={null}
					moonLabels={moonLabels}
					onHover={() => undefined}
					onOpenThread={() => undefined}
					onSelect={() => undefined}
					palette={planetsPalette(EMPTY_THEME)}
					registry={{ current: createOverlayRegistry() }}
					system={system}
				/>
			);
		const pinned = "group-data-[label=pinned]/wrap:opacity-100";
		expect(overlay()).toContain(pinned);
		expect(overlay(true)).toBe(overlay());
		const hover = overlay(false);
		expect(hover).not.toContain(pinned);
		expect(hover).toContain("group-hover/moon:opacity-100");
	});
});
