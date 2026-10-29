import "./card-table-test-dom.ts";
// The DOM first, before React loads (the side-effect import above stays first).
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { cardTableDom } from "./card-table-test-dom.ts";

cardTableDom();

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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_ASK_IDS, FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } =
	await import("./game-acts-fixture.ts");
const { overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { askOwners } = await import("./interface-ask-card.tsx");
const { CardActProps, cardOverlays, cardPaths } = await import(
	"./card-table-acts.tsx"
);
const { MAX_SEATS } = await import("./card-table-model.ts");
const { roomSeats } = await import("./card-table-room.ts");

afterAll(() => {
	mock.restore();
});

/** Where the phone's layout starts (the overlay budget's narrow width). */
const PHONE = 640;

/**
 * The card room's act props exactly as CardTableInterface builds them at a
 * `width` stage (its six chairs, overlay budget and queue), rendered as the
 * kit's plates.
 */
function renderRoom(
	width: number,
	snapshot: InterfaceSnapshot = usefulStateFixture()
) {
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const { offStage, onStage } = stageAgents(acts, MAX_SEATS);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(cardOverlays(onStage, slots, offStage, true));
	const narrow = width < PHONE;
	const seats = roomSeats();
	const seated = onStage.flatMap((item, slot) => {
		const seat = seats[slot];
		return seat ? [{ act: item, seat }] : [];
	});
	const asked: string[] = [];
	const blocked: string[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() =>
			root.render(
				<CardActProps
					clock={FIXTURE_CLOCK}
					dealer
					iconOnly={budget.iconOnly}
					narrow={narrow}
					nowMs={FIXTURE_NOW}
					offStage={offStage}
					onAsk={(askId) => asked.push(askId)}
					onBlocker={(threadId) => blocked.push(threadId)}
					onQueue={() => undefined}
					onStage={onStage}
					owners={askOwners(acts)}
					paths={cardPaths(seats, narrow)}
					reduced
					seated={seated}
					shown={shown}
					slots={slots}
					snapshot={snapshot}
				/>
			)
		);
	} finally {
		console.error = errors;
	}
	const dispose = () => {
		act(() => root.unmount());
		container.remove();
	};
	return { asked, blocked, budget, container, dispose, shown };
}

/** The seated agents' exempt targets in the room (the rest are off stage). */
const EXPECTED = { alarm: 3, notice: 1 };

describe("card room act props (test 21, rendered)", () => {
	for (const width of [1280, 390]) {
		test(`every exempt target is a focusable, named control at ${width}`, () => {
			const { budget, container, dispose, shown } = renderRoom(width);
			const narrow = width < PHONE;
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
				expect(alarms).toEqual([
					"Di stopped: Tests failed, 20 minutes ago.",
					"Di stopped: Nightly backup failed, 6 hours ago.",
					"Ed stopped: Interrupted, about 1 hour ago.",
				]);
				// The tally is the HUD's button, never a plate in the room.
				expect(shown.has("tally:off")).toBe(true);
				expect(container.querySelector('[data-tally="off"]')).toBeNull();
				// Rendered budgeted overlays stay within the budget.
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(narrow ? 8 : 16);
				expect(budget.iconOnly).toBe(narrow);
				// No bubbles in the room: the players never speak.
				expect(container.querySelector("[data-bubble]")).toBeNull();
			} finally {
				dispose();
			}
		});
	}

	test("the travelling cards open their asks; no Approve or Reject on the felt", () => {
		const { asked, container, dispose } = renderRoom(1280);
		try {
			const plates = [
				...container.querySelectorAll<HTMLButtonElement>(
					'button[data-you-spot="slot"]'
				),
			];
			const ada = plates.find((plate) => plate.textContent?.startsWith("Ada"));
			// The seat plate is Ada's keyboard target; the card is a pointer path.
			expect(ada?.tabIndex).toBe(-1);
			act(() => ada?.click());
			expect(asked).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
			expect(
				[...container.querySelectorAll("button")].filter((button) =>
					/^(Approve|Reject)$/.test(button.textContent ?? "")
				)
			).toEqual([]);
		} finally {
			dispose();
		}
	});

	test("Di's alarms open her blocker cards, one thread each", () => {
		const { blocked, container, dispose } = renderRoom(390);
		try {
			const di = [
				...container.querySelectorAll<HTMLButtonElement>(
					'[data-act-target="alarm"]'
				),
			].filter((item) =>
				item.getAttribute("aria-label")?.startsWith("Di stopped")
			);
			expect(di).toHaveLength(2);
			for (const alarm of di) {
				act(() => alarm.click());
			}
			// Each alarm opens its own thread's blocker card.
			expect(new Set(blocked).size).toBe(2);
		} finally {
			dispose();
		}
	});
});
