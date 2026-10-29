import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The plates are drei `Html` overlays; outside a Canvas, render them in place.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GameTitlePlate } = await import("./game-hud.tsx");
const { IsoMarker, stagePlates } = await import("./game3d-stage.tsx");
const { VillagerPlate, initialOf, villagerPlateLabel } = await import(
	"./game3d-villager.tsx"
);

afterAll(() => {
	GlobalRegistrator.unregister();
});

function render(node: ReactNode): {
	container: HTMLElement;
	unmount: () => void;
} {
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

const LOOKS = {
	body: "x",
	collar: "x",
	hair: "x",
	hairStyle: 0,
	iris: "x",
	skin: "x",
};

function spec(extra: Record<string, unknown> = {}) {
	return {
		id: "ada",
		label: "Ada asks: Can I run shell.run now?",
		looks: LOOKS,
		name: "Ada",
		pose: "needs-you" as const,
		position: [0, 0, 0] as [number, number, number],
		...extra,
	};
}

describe("VillagerPlate", () => {
	test("activate replaces onSelect, drops aria-pressed and is focusable", () => {
		let activated = 0;
		let selected = 0;
		const view = render(
			<VillagerPlate
				onSelect={() => {
					selected += 1;
				}}
				selected
				spec={spec({ activate: () => (activated += 1) })}
			/>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("aria-pressed")).toBeNull();
		expect(button?.tabIndex).toBe(0);
		act(() => button?.click());
		expect(activated).toBe(1);
		expect(selected).toBe(0);
		view.unmount();
	});

	test("without activate it selects and keeps aria-pressed", () => {
		const picked: string[] = [];
		const view = render(
			<VillagerPlate
				onSelect={(id) => picked.push(id)}
				selected={false}
				spec={spec({ id: "cy", name: "Cy" })}
			/>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("aria-pressed")).toBe("false");
		act(() => button?.click());
		expect(picked).toEqual(["cy"]);
		view.unmount();
	});

	test("an activate-only plate is focusable; one with neither is not", () => {
		const withActivate = render(
			<VillagerPlate
				selected={false}
				spec={spec({ activate: () => undefined })}
			/>
		);
		expect(withActivate.container.querySelector("button")?.tabIndex).toBe(0);
		withActivate.unmount();
		const inert = render(<VillagerPlate selected={false} spec={spec()} />);
		expect(inert.container.querySelector("button")?.tabIndex).toBe(-1);
		inert.unmount();
	});

	test("iconOnly shows the initial and keeps the full name", () => {
		const view = render(
			<VillagerPlate
				iconOnly
				selected={false}
				spec={spec({ activate: () => undefined })}
			/>
		);
		const button = view.container.querySelector("button");
		// The badge ("!") sits in the plate too; the name part is the initial.
		expect(button?.lastElementChild?.textContent).toBe("A");
		expect(button?.getAttribute("aria-label")).toBe(
			"Ada asks: Can I run shell.run now?"
		);
		view.unmount();
	});

	test("a scripted villager's label drops the says suffix", () => {
		const bubble = { label: "Run deploy.sh?" };
		expect(villagerPlateLabel({ label: "Ada", life: undefined }, bubble)).toBe(
			"Ada, says Run deploy.sh?"
		);
		expect(
			villagerPlateLabel(
				{ label: "Ada asks: x.", life: { key: "k", steps: [] } },
				bubble
			)
		).toBe("Ada asks: x.");
	});
});

describe("IsoMarker", () => {
	test("activate replaces onSelect and drops aria-pressed", () => {
		let activated = 0;
		let selected = 0;
		const view = render(
			<IsoMarker
				activate={() => {
					activated += 1;
				}}
				at={[0, 0, 0]}
				label="Ada asks: x. Answer their ask."
				onSelect={() => {
					selected += 1;
				}}
				pressed
			>
				Ada
			</IsoMarker>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("aria-pressed")).toBeNull();
		expect(button?.tabIndex).toBe(0);
		act(() => button?.click());
		expect([activated, selected]).toEqual([1, 0]);
		view.unmount();
	});

	test("keeps aria-pressed and onSelect without activate; iconOnly shows a glyph", () => {
		let selected = 0;
		const view = render(
			<IsoMarker
				at={[0, 0, 0]}
				iconOnly
				label="Cy is editing. Open their desk."
				onSelect={() => {
					selected += 1;
				}}
				pressed={false}
			>
				Cy at desk
			</IsoMarker>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("aria-pressed")).toBe("false");
		expect(button?.textContent).toBe("C");
		act(() => button?.click());
		expect(selected).toBe(1);
		view.unmount();
	});
});

describe("GameTitlePlate keepStatus", () => {
	test("compact hides the status visually; keepStatus keeps it", () => {
		const hidden = render(
			<GameTitlePlate compact status="3 need you" title="Farm" />
		);
		expect(hidden.container.querySelector(".sr-only")?.textContent).toBe(
			"3 need you"
		);
		hidden.unmount();
		const kept = render(
			<GameTitlePlate compact keepStatus status="3 need you" title="Farm" />
		);
		expect(kept.container.querySelector(".sr-only")).toBeNull();
		expect(kept.container.textContent).toContain("3 need you");
		kept.unmount();
	});
});

describe("initials", () => {
	test("an emoji name keeps its whole first character", () => {
		expect(initialOf("🦊 Fox")).toBe("🦊");
		expect(initialOf("Ada")).toBe("A");
		expect(initialOf("")).toBe("");
		const view = render(
			<IsoMarker
				at={[0, 0, 0]}
				iconOnly
				label="🦊 Fox, idle"
				onSelect={() => undefined}
			>
				Fox
			</IsoMarker>
		);
		const button = view.container.querySelector("button");
		expect(button?.textContent).toBe("🦊");
		expect(button?.getAttribute("aria-label")).toBe("🦊 Fox, idle");
		view.unmount();
	});
});

describe("progress pips", () => {
	test("only discrete totals are tracked; an estimate's ms total never is", async () => {
		const { discreteTotal, pipShrink } = await import("./game3d-meters.tsx");
		const estimate = {
			done: 900_000,
			kind: "estimate" as const,
			source: "estimate" as const,
			total: 1_200_000,
		};
		expect(discreteTotal(estimate)).toBeNull();
		expect(discreteTotal(null)).toBeNull();
		expect(
			discreteTotal({ done: 3, kind: "plan", source: "messages", total: 7 })
		).toBe(7);
		// estimate -> plan: nothing shrinks (this froze the tab with ~1M ghosts).
		expect(pipShrink(discreteTotal(estimate), 3)).toBe(0);
		// plan(7) -> plan(3): four drawn pips shrink away.
		expect(pipShrink(7, 3)).toBe(4);
		// plan(20) -> plan(12): both draw 8, so nothing shrinks.
		expect(pipShrink(20, 12)).toBe(0);
		expect(pipShrink(30, 2)).toBe(6);
	});

	test("pips fill by floor, all of them only when every step is done", async () => {
		const { pipCounts } = await import("./game3d-meters.tsx");
		expect(pipCounts({ done: 3, total: 7 })).toEqual({
			count: 7,
			filled: 3,
			scale: 1,
		});
		expect(pipCounts({ done: 19, total: 20 })).toEqual({
			count: 8,
			filled: 7,
			scale: 0.65,
		});
		expect(pipCounts({ done: 20, total: 20 }).filled).toBe(8);
		expect(pipCounts({ done: 0, total: 5 }).filled).toBe(0);
	});
});

describe("IsoMarker youSpot", () => {
	test("a marker can be a you-spot queue plate and a per-agent target", () => {
		const view = render(
			<IsoMarker
				actAgent="bo"
				at={[0, 0, 0]}
				label="Bo asks: x. Answer their ask."
				onSelect={() => undefined}
				youSpot="slot"
			>
				Bo · 3m
			</IsoMarker>
		);
		const button = view.container.querySelector("button");
		expect(button?.getAttribute("data-you-spot")).toBe("slot");
		expect(button?.getAttribute("data-act-agent")).toBe("bo");
		view.unmount();
		const plain = render(
			<IsoMarker at={[0, 0, 0]} label="Cy" onSelect={() => undefined}>
				Cy
			</IsoMarker>
		);
		expect(
			plain.container.querySelector("button")?.hasAttribute("data-you-spot")
		).toBe(false);
		plain.unmount();
	});
});

describe("act stage helpers", () => {
	test("unread asks are other reply asks, newest first; old blockers are uncounted ones", async () => {
		const { oldBlockersOf, unreadAsksOf } = await import(
			"./game3d-act-stage.tsx"
		);
		const { agentActs } = await import("@ryuhq/protocol/interfaces");
		const { FIXTURE_CLOCK, FIXTURE_NOW_MS, usefulStateFixture } = await import(
			"@ryuhq/protocol/interfaces-fixture"
		);
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW_MS, FIXTURE_CLOCK);
		let unreadSeen = 0;
		for (const act of acts.values()) {
			const unread = unreadAsksOf(act, snapshot);
			unreadSeen += unread.length;
			for (const ask of unread) {
				expect(ask.kind).toBe("reply");
				expect(ask.id).not.toBe(act.ask?.id);
			}
			const times = unread.map((ask) => Date.parse(ask.since ?? "") || 0);
			expect(times).toEqual([...times].sort((a, b) => b - a));
			for (const blocker of oldBlockersOf(act, snapshot)) {
				expect(act.blockers).not.toContain(blocker);
			}
		}
		expect(unreadSeen).toBeGreaterThan(0);
	});
});

describe("station board", () => {
	test("stacks only the chosen status words, limit first and cue last", async () => {
		const { stationLines } = await import("./game3d-act-stage.tsx");
		const { agentActs } = await import("@ryuhq/protocol/interfaces");
		const { FIXTURE_CLOCK, FIXTURE_NOW_MS, usefulStateFixture } = await import(
			"@ryuhq/protocol/interfaces-fixture"
		);
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW_MS, FIXTURE_CLOCK);
		const cy = [...acts.values()].find((act) => act.agentName === "Cy");
		if (!cy) {
			throw new Error("the fixture has no Cy");
		}
		const id = cy.agentId;
		const all = new Set([`progress:${id}`, `elapsed:${id}`, `next:${id}`]);
		expect(stationLines(cy, all).map((line) => line.text)).toEqual([
			"3/7",
			"12m",
			cy.next ?? "",
		]);
		expect(stationLines(cy, new Set([`elapsed:${id}`]))).toEqual([
			{ id: `elapsed:${id}`, kind: "elapsed", text: "12m" },
		]);
		expect(stationLines(cy, new Set())).toEqual([]);
	});
});

describe("IsoMarker focusable", () => {
	test("focusable={false} stays clickable but leaves the Tab order", () => {
		let clicked = 0;
		const view = render(
			<IsoMarker
				at={[0, 0, 0]}
				focusable={false}
				label="Ada at the screen"
				onSelect={() => {
					clicked += 1;
				}}
			>
				Ada
			</IsoMarker>
		);
		const button = view.container.querySelector("button");
		expect(button?.tabIndex).toBe(-1);
		expect(button?.hasAttribute("data-iso-target")).toBe(true);
		act(() => button?.click());
		expect(clicked).toBe(1);
		view.unmount();
	});
});

describe("act plates beside a figure", () => {
	test("side right hangs the plate off its anchor; row lifts it a plate row", async () => {
		const { ActPlate, PLATE_ROW_GAP } = await import("./game3d-signs.tsx");
		const view = render(
			<ActPlate
				at={[0, 0, 0]}
				focusable
				kind="alarm"
				label="Di stopped: Tests failed"
				onActivate={() => undefined}
				row={2}
				side="right"
			>
				Tests failed
			</ActPlate>
		);
		const wrapper = view.container.querySelector("button")?.parentElement;
		expect(wrapper?.style.transform).toBe(
			`translate(0, calc(-50% - 2 * (100% + ${PLATE_ROW_GAP}px)))`
		);
		view.unmount();
		const centred = render(
			<ActPlate
				at={[0, 0, 0]}
				focusable
				kind="alarm"
				label="Di stopped: Tests failed"
				onActivate={() => undefined}
			>
				Tests failed
			</ActPlate>
		);
		expect(
			centred.container.querySelector("button")?.parentElement?.style.transform
		).toBe("");
		centred.unmount();
	});
});

describe("GameTitlePlate keepStatus wraps on compact", () => {
	test("the act summary wraps to two lines instead of truncating", () => {
		const view = render(
			<GameTitlePlate
				compact
				keepStatus
				status="3 need you · 2 working · 1 failed · 1 limited"
				title="Farm"
			/>
		);
		const status = [...view.container.querySelectorAll("p")].at(-1);
		expect(status?.className).toContain("line-clamp-2");
		expect(status?.className).not.toContain("truncate");
		view.unmount();
	});

	test("gameTitleHeight matches the plate's own classes", async () => {
		const {
			GAME_SPACING_REM,
			GAME_TITLE_COMPACT_PX,
			GAME_TITLE_COMPACT_WRAPPED_PX,
			gameTitleHeight,
		} = await import("./game-hud.tsx");
		const view = render(
			<GameTitlePlate compact keepStatus status="3 need you" title="Farm" />
		);
		const plate = view.container.firstElementChild;
		const [title, status] = view.container.querySelectorAll("p");
		// One line: min-h-12, twelve spacing steps.
		expect(plate?.className).toContain("min-h-12");
		expect(plate?.className).toContain("border-2");
		expect(gameTitleHeight()).toBeCloseTo(46.08);
		expect(gameTitleHeight(1, 20)).toBeCloseTo(12 * GAME_SPACING_REM * 20);
		expect(GAME_TITLE_COMPACT_PX).toBeCloseTo(46.08);
		// Wrapped: the title's and two status lines' leading plus the border.
		expect(title?.className).toContain("leading-[21px]");
		expect(status?.className).toContain("leading-[18px]");
		expect(status?.className).toContain("line-clamp-2");
		expect(GAME_TITLE_COMPACT_WRAPPED_PX).toBe(21 + 2 * 18 + 2 * 2);
		expect(gameTitleHeight(2)).toBe(61);
		view.unmount();
	});
});

describe("villager tools", () => {
	test("scale and ledger have parts, like the book and hammer", async () => {
		const { toolPartsFor } = await import("./game3d-villager.tsx");
		expect(toolPartsFor("scale").length).toBe(4);
		expect(toolPartsFor("ledger").length).toBe(3);
		expect(toolPartsFor("book").length).toBe(2);
		expect(toolPartsFor("scale").every((part) => part.limb === "right")).toBe(
			true
		);
	});
});

describe("bubble side", () => {
	test("auto bubbles start up-right and are marked for the stage to place", async () => {
		const { LifeBubbleTag } = await import("./game3d-life.tsx");
		const auto = render(<LifeBubbleTag bubble={{ label: "3 files edited" }} />);
		const bubble = auto.container.querySelector("[data-life-bubble]");
		expect(bubble?.getAttribute("data-side")).toBe("right");
		expect(bubble?.hasAttribute("data-bubble-auto")).toBe(true);
		auto.unmount();
		const left = render(
			<LifeBubbleTag bubble={{ label: "Run deploy.sh?" }} side="left" />
		);
		const fixed = left.container.querySelector("[data-life-bubble]");
		expect(fixed?.getAttribute("data-side")).toBe("left");
		expect(fixed?.hasAttribute("data-bubble-auto")).toBe(false);
		left.unmount();
	});
});

describe("anchor redraws", () => {
	test("only a still, reduced-motion canvas asks for the extra frame", async () => {
		const { needsAnchorRedraw } = await import("./game3d-villager.tsx");
		expect(needsAnchorRedraw(true, true)).toBe(true);
		// A strolling villager on a paused (demand) canvas: no endless redraw.
		expect(needsAnchorRedraw(true, false)).toBe(false);
		expect(needsAnchorRedraw(false, true)).toBe(false);
	});
});

describe("life frames", () => {
	test("a playing script keeps the canvas drawing, then one frame more", async () => {
		const { needsLifeFrame } = await import("./game3d-villager.tsx");
		const at = (busy: number, wasBusy: boolean, moved = true) =>
			needsLifeFrame({ busy, moved, reducedMotion: false, wasBusy });
		expect(at(2, false)).toBe(true);
		expect(at(0, true)).toBe(true);
		// Settled, only strolling villagers moving: the paused canvas idles.
		expect(at(0, false)).toBe(false);
	});
});

describe("stage plates", () => {
	test("one list: kit plates and bare you-spots, not overlays inside a plate", () => {
		const stage = document.createElement("div");
		stage.innerHTML = `
			<div data-iso-plate id="plate"><span data-you-spot="slot" id="inner"></span></div>
			<div data-you-spot="tray" id="bare"></div>
			<button data-iso-target id="target"></button>
			<div id="other"></div>`;
		expect(stagePlates(stage).map((plate) => plate.id)).toEqual([
			"plate",
			"bare",
			"target",
		]);
	});
});

describe("seasonal props", () => {
	test("a candle melts with the wait, never to a stub", async () => {
		const { candleHeight } = await import("./game3d-meters.tsx");
		expect(candleHeight(1)).toBeGreaterThan(candleHeight(0.5));
		expect(candleHeight(0.5)).toBeGreaterThan(candleHeight(0));
		expect(candleHeight(0)).toBeGreaterThan(0);
	});
});

describe("kit game settings", () => {
	test("work bubbles off hides plain work bubbles but keeps asks", async () => {
		const { GameKitSettingsContext } = await import("./game3d-settings.tsx");
		const plate = (workBubbles: boolean, tone: "ask" | "plain") => (
			<GameKitSettingsContext.Provider
				value={{ overlayDensity: "full", workBubbles }}
			>
				<VillagerPlate
					bubble={{ label: tone === "ask" ? "Need you" : "Editing", tone }}
					onSelect={() => undefined}
					selected={false}
					spec={spec({})}
				/>
			</GameKitSettingsContext.Provider>
		);
		const bubbleText = (node: ReactNode) => {
			const view = render(node);
			const text =
				view.container.querySelector("[data-life-bubble]")?.textContent ?? null;
			view.unmount();
			return text;
		};
		expect(bubbleText(plate(true, "plain"))).toContain("Editing");
		expect(bubbleText(plate(false, "plain"))).toBeNull();
		expect(bubbleText(plate(false, "ask"))).toContain("Need you");
	});

	test("the host's animations-off reads as reduced motion", async () => {
		const { HostReducedMotionContext } = await import("./game3d-settings.tsx");
		const { useReducedMotion } = await import("./game3d-stage.tsx");
		let seen = null as boolean | null;
		const Probe = () => {
			seen = useReducedMotion();
			return null;
		};
		let view = render(<Probe />);
		expect(seen).toBe(false);
		view.unmount();
		view = render(
			<HostReducedMotionContext.Provider value>
				<Probe />
			</HostReducedMotionContext.Provider>
		);
		expect(seen).toBe(true);
		view.unmount();
	});
});
