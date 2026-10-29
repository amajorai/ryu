import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
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
const { actOverlays, overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { askOwners } = await import("./interface-ask-card.tsx");
const { RidesActProps, RidesCarPlate, ridesYouSpot } = await import(
	"./rides-acts.tsx"
);

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

function silenced<T>(run: () => T): T {
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		return run();
	} finally {
		console.error = errors;
	}
}

const mounted = new Set<() => void>();
afterEach(() => {
	for (const dispose of [...mounted]) {
		dispose();
	}
	resetBody();
});

/**
 * Unmounts what a test left mounted and clears anything portalled to the
 * body (sheets, dialogs, the announcer) so no test sees another's DOM.
 */
function resetBody() {
	document.body.replaceChildren();
	document.body.removeAttribute("style");
	document.body.removeAttribute("data-scroll-locked");
}

function mountNode(
	node: Parameters<ReturnType<typeof createRoot>["render"]>[0]
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	silenced(() => act(() => root.render(node)));
	const dispose = () => {
		if (!mounted.delete(dispose)) {
			return;
		}
		act(() => root.unmount());
		container.remove();
	};
	mounted.add(dispose);
	return { container, dispose };
}

/**
 * The rides act props and car plates (test 21, 15a): every agent's car on
 * the map (all on stage), the kerb from `ridesYouSpot`, at 1280 and 390.
 */
function scene(width: number) {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(actOverlays(onStage, slots, offStage));
	const cars = new Map(
		onStage.map(
			(item, index) =>
				[item.agentId, [(index % 5) * 3, 0.02, Math.floor(index / 5) * 3]] as [
					string,
					[number, number, number],
				]
		)
	);
	const opened: string[] = [];
	const view = {
		acts,
		clock: FIXTURE_CLOCK,
		iconOnly: budget.iconOnly,
		nowMs: FIXTURE_NOW,
		offStage,
		onAsk: (askId: string) => {
			opened.push(askId);
		},
		onBlocker: () => undefined,
		onQueue: () => undefined,
		owners: askOwners(acts),
		privacy: "full" as const,
		shown,
		slots,
		snapshot,
	};
	return {
		acts,
		cars,
		onStage,
		opened,
		view,
		you: ridesYouSpot([0, 0.02, 8], budget.iconOnly),
	};
}

describe("rides act props (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`exempt targets are focusable named controls at ${width}`, () => {
			const { cars, onStage, view, you } = scene(width);
			// The props and every car's plate, the queued ones at the kerb.
			const { container, dispose } = mountNode(
				<>
					<RidesActProps
						cars={cars}
						onStage={onStage}
						reduced
						view={view}
						youLayout={you.layout}
					/>
					{onStage.map((item) => (
						<RidesCarPlate
							act={item}
							at={cars.get(item.agentId) ?? [0, 0, 0]}
							key={item.agentId}
							label="Show the trip."
							onSelect={() => undefined}
							pressed={false}
							reduced
							view={view}
						/>
					))}
				</>
			);
			try {
				const expected = {
					alarm: 3,
					notice: 1,
					suggestion: 1,
					tray: 1,
					unread: 1,
				};
				for (const [kind, count] of Object.entries(expected)) {
					const targets = [
						...container.querySelectorAll<HTMLElement>(
							`[data-act-target="${kind}"]`
						),
					];
					expect(targets).toHaveLength(count);
					for (const target of targets) {
						expect(target.tabIndex).toBe(0);
						expect(target.getAttribute("aria-label")?.length).toBeGreaterThan(
							10
						);
						expect(target.hasAttribute("data-icon-only")).toBe(
							width < 640 && kind !== "notice"
						);
					}
				}
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(width < 640 ? 8 : 16);
				// The limit is a red light.
				const words = [
					...container.querySelectorAll('[data-budgeted-overlay="limit"]'),
				].map((item) => item.textContent);
				if (width >= 640) {
					expect(words).toEqual(["Red light till 15:10"]);
				}
				// Every car has its plate; the asking ones are queue plates.
				const plates = [
					...container.querySelectorAll<HTMLElement>("button[data-act-agent]"),
				];
				expect(plates).toHaveLength(onStage.length);
				const asking = onStage.filter(
					(item) => item.act === "asking" && item.ask
				);
				expect(asking.length).toBeGreaterThan(0);
				expect(
					container.querySelectorAll('[data-you-spot="slot"]').length
				).toBeGreaterThan(0);
				// The limit stays on a phone too, and the queue's "+N more"
				// shows exactly when the queue overflows (every car is on the
				// map, so there is no off-stage tally).
				expect(
					container.querySelectorAll('[data-budgeted-overlay="limit"]')
				).toHaveLength(1);
				expect(
					container.querySelectorAll('[data-act-target="tally"]')
				).toHaveLength(view.slots.overflow > 0 ? 1 : 0);
				if (width < 640) {
					// A phone has no room for ask bubbles: the queue says it.
					for (const item of asking) {
						const plate = container.querySelector(
							`button[data-act-agent="${item.agentId}"]`
						);
						expect(plate?.querySelector("[data-life-bubble]")).toBeNull();
					}
				}
			} finally {
				dispose();
			}
		});
	}
});

describe("rides car plates, rendered (15a)", () => {
	test("Ada's plate answers her ask; Cy's keeps the map's action", () => {
		const { acts, opened, view } = scene(1280);
		const actOf = (name: string) => {
			const found = [...acts.values()].find((item) => item.agentName === name);
			if (!found) {
				throw new Error(name);
			}
			return found;
		};
		const ada = actOf("Ada");
		let selected = 0;
		const adaPlate = mountNode(
			<RidesCarPlate
				act={ada}
				at={[0, 1, 0]}
				label="Show the trip."
				onSelect={() => {
					selected += 1;
				}}
				pressed={false}
				view={view}
			/>
		);
		const adaButton = adaPlate.container.querySelector("button");
		expect(adaButton?.hasAttribute("aria-pressed")).toBe(false);
		expect(adaButton?.tabIndex).toBe(0);
		expect(adaButton?.getAttribute("data-act-agent")).toBe(ada.agentId);
		expect(adaButton?.getAttribute("aria-label")).toBe(
			`${ada.ariaLabel} Answer their ask.`
		);
		act(() => adaButton?.click());
		expect(opened).toEqual([ada.ask?.id ?? ""]);
		expect(selected).toBe(0);
		adaPlate.dispose();
		const cy = actOf("Cy");
		const cyPlate = mountNode(
			<RidesCarPlate
				act={cy}
				at={[0, 1, 0]}
				label="Show the trip."
				onSelect={() => {
					selected += 1;
				}}
				pressed={false}
				view={view}
			/>
		);
		const cyButton = cyPlate.container.querySelector("button");
		expect(cyButton?.getAttribute("aria-pressed")).toBe("false");
		expect(cyButton?.getAttribute("aria-label")).toBe(
			`${cy.ariaLabel} Show the trip.`
		);
		act(() => cyButton?.click());
		expect(selected).toBe(1);
		cyPlate.dispose();
	});
});
