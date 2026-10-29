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
const { actOverlays, overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { askOwners } = await import("./interface-ask-card.tsx");
const { offStageLabel, offStageText } = await import("./game3d-signs.tsx");
const { LobbyActProps, lobbyYouSpot } = await import("./lobby-acts.tsx");
const { SQUAD_SIZE } = await import("./lobby-model.ts");

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

/**
 * The lobby's act props rendered with its own squad (`stageAgents`) and
 * pad (`lobbyYouSpot`) at 1280 and 390: the off-stage tally stands beside
 * the podium as a focusable plate that counts the agents off stage.
 */
function renderProps(width: number) {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const { offStage, onStage } = stageAgents(acts, SQUAD_SIZE);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(actOverlays(onStage, slots, offStage));
	const stations = new Map(
		onStage.map(
			(item, index) =>
				[item.agentId, [(index - 1.5) * 1.8, 0.42, 0]] as [
					string,
					[number, number, number],
				]
		)
	);
	let queued = 0;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() =>
			root.render(
				<LobbyActProps
					onStage={onStage}
					reduced
					stations={stations}
					view={{
						acts,
						clock: FIXTURE_CLOCK,
						iconOnly: budget.iconOnly,
						nowMs: FIXTURE_NOW,
						offStage,
						onAsk: () => undefined,
						onBlocker: () => undefined,
						onQueue: () => {
							queued += 1;
						},
						owners: askOwners(acts),
						privacy: "full",
						shown,
						slots,
						snapshot,
					}}
					you={lobbyYouSpot(budget.iconOnly)}
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
	return { container, dispose, offStage, queued: () => queued };
}

describe("lobby act props", () => {
	for (const width of [1280, 390]) {
		test(`the off-stage tally is a named, focusable plate at ${width}`, () => {
			const { container, dispose, offStage, queued } = renderProps(width);
			try {
				const tally =
					container.querySelector<HTMLElement>('[data-tally="off"]');
				expect(tally).not.toBeNull();
				expect(tally?.textContent).toBe(offStageText(offStage));
				expect(tally?.textContent).toBe(
					"+6: 1 limited, 2 working, 1 delivering, 2 idle"
				);
				expect(tally?.getAttribute("aria-label")).toBe(
					offStageLabel(offStage.count)
				);
				expect(tally?.tabIndex).toBe(0);
				act(() => tally?.click());
				expect(queued()).toBe(1);
			} finally {
				dispose();
			}
		});
	}

	for (const width of [1280, 390]) {
		test(`every exempt target is a focusable, named control at ${width}`, () => {
			const { container, dispose } = renderProps(width);
			try {
				const expected = { alarm: 3, notice: 1 };
				for (const [kind, count] of Object.entries(expected)) {
					const targets = [
						...container.querySelectorAll<HTMLElement>(
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
						expect(target.hasAttribute("data-icon-only")).toBe(
							width < 640 && kind !== "notice"
						);
					}
				}
				const names = [
					...container.querySelectorAll('[data-act-target="alarm"]'),
				].map((item) => item.getAttribute("aria-label"));
				expect(names).toContain("Di stopped: Tests failed, 20 minutes ago.");
			} finally {
				dispose();
			}
		});
	}
});
