// Interface panels and the Departures route follow the reading direction:
// under an Arabic UI a panel docked at the inline end slides in from that end,
// and the flight's progress fill and plane run from From (inline start) to To.

import { describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CinemaArt } from "./cinema-art.tsx";
import { cinemaArt } from "./cinema-model.ts";
import { cinemaShade } from "./cinema-palette.ts";
import { DashboardThreadPanel } from "./dashboard-panel.tsx";
import { buildBoards } from "./departures-model.ts";
import type { Flight } from "./departures-model-types.ts";
import { DeparturesPanel } from "./departures-panel.tsx";

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	events: [],
	groups: [],
	threads: [
		{
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: null,
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: new Date(NOW - 60_000).toISOString(),
		},
	],
	version: 1,
};

function render(direction: "ltr" | "rtl", element: ReactElement): string {
	return renderToStaticMarkup(
		<DirectionProvider direction={direction}>
			<div dir={direction}>{element}</div>
		</DirectionProvider>
	);
}

function firstFlight(status: Flight["status"]): Flight {
	const boards = buildBoards(SNAPSHOT, NOW);
	const flight = [...boards.departures, ...boards.arrivals][0];
	if (!flight) {
		throw new Error("fixture produced no flight");
	}
	return { ...flight, status };
}

function departuresPanel(direction: "ltr" | "rtl", flight: Flight): string {
	return render(
		direction,
		<DeparturesPanel
			booking={false}
			flight={flight}
			flights={[flight]}
			headingRef={null}
			now={NOW}
			onBook={() => undefined}
			onClose={() => undefined}
			onOpen={() => undefined}
			snapshot={SNAPSHOT}
			threadView={null}
		/>
	);
}

/** The inline `left` the plane marker is placed at, in percent. */
function planeLeft(html: string): number {
	const match = html.match(
		/-translate-y-1\/2[^"]*"[^>]*style="left:(-?[\d.]+)%/
	);
	if (!match?.[1]) {
		throw new Error("plane marker not found");
	}
	return Number(match[1]);
}

describe("interface motion under right-to-left", () => {
	test("the Departures fill, rail and plane anchor at the inline start", () => {
		const flight = firstFlight("delayed");
		const html = departuresPanel("rtl", flight);
		expect(html).toContain("absolute start-0 top-1/2 h-px");
		expect(html).toContain("start-[3.5px]");
		expect(html).not.toMatch(/\bleft-0\b|left-\[3\.5px\]/);
		expect(html).toContain("rtl:-scale-x-100");
	});

	test("the plane flies toward the inline end in either direction", () => {
		const landed = firstFlight("landed");
		const waiting = firstFlight("scheduled");
		expect(planeLeft(departuresPanel("ltr", landed))).toBe(100);
		expect(planeLeft(departuresPanel("rtl", landed))).toBe(0);
		expect(planeLeft(departuresPanel("ltr", waiting))).toBe(0);
		expect(planeLeft(departuresPanel("rtl", waiting))).toBe(100);
	});

	test("an inline-end thread panel enters from the inline end", () => {
		const panel = (direction: "ltr" | "rtl") =>
			render(
				direction,
				<DashboardThreadPanel
					headingRef={null}
					now={NOW}
					onClose={() => undefined}
					snapshot={SNAPSHOT}
					thread={SNAPSHOT.threads[0]}
					threadView={null}
				/>
			);
		expect(panel("ltr")).toContain("translateX(40px)");
		expect(panel("rtl")).toContain("translateX(-40px)");
	});

	test("the Cinema hero shade and title wall swap sides under RTL", () => {
		expect(cinemaShade("start")).toContain("linear-gradient(90deg");
		expect(cinemaShade("start", "rtl")).toContain("linear-gradient(270deg");
		expect(cinemaShade("bottom", "rtl")).toBe(cinemaShade("bottom"));
		const hero = (direction: "ltr" | "rtl") =>
			render(
				direction,
				<CinemaArt
					frame="hero"
					spec={cinemaArt("thread-notes")}
					text="Release notes"
				/>
			);
		for (const direction of ["ltr", "rtl"] as const) {
			const html = hero(direction);
			// The wall sits at the inline end, opposite the start-shaded info.
			expect(html).toContain("inset-inline-end:-1cqw");
			expect(html).not.toMatch(/[;"]right:/);
			expect(html).toContain(
				direction === "rtl" ? "linear-gradient(270deg" : "linear-gradient(90deg"
			);
		}
	});
});
