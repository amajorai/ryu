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
const { QuizActProps, quizContestant, quizPaths, quizYouSpot } = await import(
	"./quiz-acts.tsx"
);
const { QUIZ_PODIUMS } = await import("./quiz-model.ts");
const { podiumSpots } = await import("./quiz-world.ts");
const { VillagerPlate } = await import("./game3d-villager.tsx");

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

function mountNode(
	node: Parameters<ReturnType<typeof createRoot>["render"]>[0]
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	silenced(() => act(() => root.render(node)));
	return {
		container,
		dispose: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/**
 * The quiz show's act props and plates, rendered with its own podiums
 * (`stageAgents` to `QUIZ_PODIUMS`) and lectern queue (`quizYouSpot`) at
 * 1280 and 390 (test 21), and the podium plates (15a).
 */
function scene(width: number) {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const { offStage, onStage } = stageAgents(acts, QUIZ_PODIUMS);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(actOverlays(onStage, slots, offStage));
	const spots = podiumSpots();
	const stations = new Map(
		onStage.map((item, index) => {
			const [x, z] = spots[index] ?? [0, 0];
			return [item.agentId, [x, 0.2, z]] as [string, [number, number, number]];
		})
	);
	let queued = 0;
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
		onQueue: () => {
			queued += 1;
		},
		owners: askOwners(acts),
		privacy: "full" as const,
		shown,
		slots,
		snapshot,
	};
	const you = quizYouSpot(budget.iconOnly);
	return {
		acts,
		budget,
		offStage,
		onStage,
		opened,
		paths: quizPaths(stations, you.points),
		queued: () => queued,
		stations,
		view,
		you,
	};
}

describe("quiz act props (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`exempt targets are focusable named controls; the tally opens the queue at ${width}`, () => {
			const { offStage, onStage, queued, stations, view, you } = scene(width);
			const { container, dispose } = mountNode(
				<QuizActProps
					onStage={onStage}
					reduced
					stations={stations}
					view={view}
					youLayout={you.layout}
				/>
			);
			try {
				for (const [kind, count] of Object.entries({ alarm: 3, notice: 1 })) {
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
				const tally =
					container.querySelector<HTMLElement>('[data-tally="off"]');
				expect(tally?.textContent).toBe(offStageText(offStage));
				expect(tally?.getAttribute("aria-label")).toBe(
					offStageLabel(offStage.count)
				);
				act(() => tally?.click());
				expect(queued()).toBe(1);
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(width < 640 ? 8 : 16);
			} finally {
				dispose();
			}
		});
	}
});

describe("quiz podium plates, rendered (15a)", () => {
	test("Ada's plate answers her ask; Cy's keeps the select action", () => {
		const { acts, opened, paths, view } = scene(1280);
		const specOf = (name: string) => {
			const found = [...acts.values()].find((item) => item.agentName === name);
			if (!found) {
				throw new Error(name);
			}
			const [spec] = quizContestant({
				act: found,
				base: { id: found.agentId, position: [0, 0.2, 0] },
				label: "Ask the final question.",
				looks: {} as never,
				paths,
				reduced: true,
				view,
			});
			if (!spec) {
				throw new Error(name);
			}
			return { act: found, spec };
		};
		const picked: string[] = [];
		const ada = specOf("Ada");
		const adaPlate = mountNode(
			<VillagerPlate
				onSelect={(id) => picked.push(id)}
				selected={false}
				spec={ada.spec}
			/>
		);
		const adaButton = adaPlate.container.querySelector("button");
		expect(adaButton?.hasAttribute("aria-pressed")).toBe(false);
		expect(adaButton?.tabIndex).toBe(0);
		act(() => adaButton?.click());
		expect(opened).toEqual([ada.act.ask?.id ?? ""]);
		expect(picked).toEqual([]);
		adaPlate.dispose();
		const cy = specOf("Cy");
		const cyPlate = mountNode(
			<VillagerPlate
				onSelect={(id) => picked.push(id)}
				selected={false}
				spec={cy.spec}
			/>
		);
		const cyButton = cyPlate.container.querySelector("button");
		expect(cyButton?.getAttribute("aria-pressed")).toBe("false");
		act(() => cyButton?.click());
		expect(picked).toEqual([cy.act.agentId]);
		cyPlate.dispose();
	});
});
