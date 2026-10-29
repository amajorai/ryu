import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The scene's plates are drei `Html` overlays; outside a Canvas, render them
// in place, and give the frame hooks a still stage, so the act props' DOM
// (the keyboard and screen-reader targets) can be checked without WebGL.
const drei = await import("@react-three/drei");
const fiber = await import("@react-three/fiber");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: () => undefined,
	useThree: (select?: (state: unknown) => unknown) => {
		const state = {
			camera: {},
			gl: { domElement: document.createElement("canvas") },
			invalidate: () => undefined,
			size: { height: 800, width: 1280 },
		};
		return select ? select(state) : state;
	},
}));

// Toon meshes build outline hulls from a live geometry: draw none here.
const materials = await import("./game3d-materials.tsx");
mock.module("./game3d-materials.tsx", () => ({
	...materials,
	ToonMesh: () => null,
}));

// Instanced props (the porch's benches) need a live scene: draw none here.
const props = await import("./game3d-props.tsx");
mock.module("./game3d-props.tsx", () => ({
	...props,
	Benches: () => null,
}));

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

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
const { limitWords } = await import("./game3d-act-stage.tsx");
const { VillagerPlate } = await import("./game3d-villager.tsx");
const {
	bedsByAgent,
	benchOf,
	FarmBedActs,
	FarmPorchActs,
	farmActVillagers,
	farmLimitText,
	farmPaths,
	porchSpots,
} = await import("./farm-acts.tsx");
const { buildFarm, layoutDiorama } = await import("./farm-model.ts");

const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const staged = stageAgents(acts, Number.POSITIVE_INFINITY);
const slots = youSpotSlots(acts, unownedAsks(fixture));
const diorama = layoutDiorama(buildFarm(fixture).fields);
const benches = benchOf(diorama, acts);
const spots = porchSpots(diorama);
const LOOKS = {
	body: "x",
	collar: "x",
	hair: "x",
	hairStyle: 0,
	iris: "x",
	skin: "x",
};
const ADA =
	"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.";

function render(node: ReactNode) {
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

/** The budget's choice at `width`, as the interface makes it (no phone work bubbles). */
function budgetAt(width: number) {
	const budget = overlayBudget(width, { domTargets: true });
	const shown = new Set(
		[
			...budget.fill(
				actOverlays(
					staged.onStage,
					slots,
					staged.offStage,
					staged.onStage.find((item) => item.act === "working")?.agentId ??
						null,
					{ reduced: true }
				)
			),
		].filter((id) => !(budget.iconOnly && id.startsWith("work:")))
	);
	return { iconOnly: budget.iconOnly, shown };
}

/** The farmers as the diorama casts them (helpers left out). */
function farmers(shown: ReadonlySet<string>, opened: string[]) {
	return farmActVillagers({
		acts,
		benches,
		diorama,
		looks: new Map(fixture.agents.map((agent) => [agent.id, LOOKS])),
		nowMs: FIXTURE_NOW,
		onAsk: (askId) => opened.push(askId),
		paths: farmPaths(diorama),
		reduced: true,
		shown,
		slots: slots.slots,
	}).filter((spec) => !spec.id.includes(":helper:"));
}

/** Every act prop of the farm, as the diorama draws them at `width`. */
function farm(width: number, opened: string[]) {
	const { iconOnly, shown } = budgetAt(width);
	const handlers = {
		clock: FIXTURE_CLOCK,
		iconOnly,
		nowMs: FIXTURE_NOW,
		onAsk: (askId: string) => opened.push(askId),
		onBlocker: (threadId: string) => opened.push(`blocker:${threadId}`),
		onQueue: () => opened.push("queue"),
		privacy: "full" as const,
		reduced: true,
		shown,
		snapshot: fixture,
	};
	return render(
		<div>
			{[...bedsByAgent(diorama)].map(([agentId, placed]) => {
				const item = acts.get(agentId);
				const bench = benches.get(agentId);
				return item ? (
					<FarmBedActs
						act={item}
						bench={
							bench
								? (spots.benches[Number(bench.slice("bench-".length))] ?? null)
								: null
						}
						handlers={handlers}
						key={agentId}
						placed={placed}
					/>
				) : null;
			})}
			<FarmPorchActs
				diorama={diorama}
				handlers={handlers}
				offStage={staged.offStage}
				onStage={staged.onStage}
				owners={askOwners(acts)}
				slots={slots}
			/>
		</div>
	);
}

const plotOf = (agentId: string) =>
	diorama.beds.find((placed) => placed.plot.agent?.id === agentId)?.plot.id ??
	"";

describe("farm scene targets", () => {
	test("15a: Ada's plate answers her ask (no aria-pressed); Cy's keeps the plot selection", () => {
		const opened: string[] = [];
		const specs = farmers(new Set(), opened);
		const ada = specs.find((spec) => spec.actAgent === "ada");
		const cy = specs.find((spec) => spec.actAgent === "cy");
		if (!(ada && cy)) {
			throw new Error("missing farmers");
		}
		const picked: string[] = [];
		const adaPlate = render(
			<VillagerPlate onSelect={(id) => picked.push(id)} selected spec={ada} />
		);
		const adaButton = adaPlate.container.querySelector("button");
		expect(adaButton?.getAttribute("aria-label")).toBe(
			`${ADA} Answer their ask.`
		);
		expect(adaButton?.getAttribute("aria-pressed")).toBeNull();
		expect(adaButton?.tabIndex).toBe(0);
		act(() => adaButton?.click());
		expect(opened).toEqual(["approval:ada-shell"]);
		expect(picked).toEqual([]);
		adaPlate.unmount();
		const cyPlate = render(
			<VillagerPlate
				onSelect={(id) => picked.push(id)}
				selected={false}
				spec={cy}
			/>
		);
		const cyButton = cyPlate.container.querySelector("button");
		expect(cyButton?.getAttribute("aria-label")).toBe(
			`${acts.get("cy")?.ariaLabel} Open their plot.`
		);
		expect(cyButton?.getAttribute("aria-pressed")).toBe("false");
		act(() => cyButton?.click());
		expect(picked).toEqual([plotOf("cy")]);
		cyPlate.unmount();
	});

	for (const width of [1280, 390]) {
		test(`21: every exempt target is rendered and focusable at ${width}`, () => {
			const opened: string[] = [];
			const view = farm(width, opened);
			const props = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-target]"),
			];
			const kinds = props.map((item) => item.dataset.actTarget);
			// Di's two lanterns and Ed's; the workflow gate's notice; Gu's basket;
			// Ju's unread mark; Ha's suggestion note.
			expect(kinds.filter((kind) => kind === "alarm")).toHaveLength(3);
			expect(kinds.filter((kind) => kind === "notice")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "tray")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "unread")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "suggestion")).toHaveLength(1);
			for (const item of props) {
				expect(item.tabIndex).toBe(0);
				expect(item.hasAttribute("data-iso-target")).toBe(true);
				expect(item.getAttribute("aria-label")?.length).toBeGreaterThan(10);
				expect(item.hasAttribute("data-icon-only")).toBe(
					width < 640 && item.dataset.actTarget !== "notice"
				);
			}
			act(() =>
				props.find((item) => item.dataset.actTarget === "tray")?.click()
			);
			expect(opened).toEqual(["reply:t-gu"]);
			view.unmount();
			const { iconOnly, shown } = budgetAt(width);
			const plates = render(
				<div>
					{farmers(shown, []).map((spec) => (
						<VillagerPlate
							iconOnly={spec.iconOnly ?? iconOnly}
							key={spec.id}
							onSelect={() => undefined}
							selected={false}
							spec={spec}
						/>
					))}
				</div>
			);
			const buttons = [
				...plates.container.querySelectorAll<HTMLElement>("[data-act-agent]"),
			];
			expect(buttons.map((button) => button.dataset.actAgent).sort()).toEqual(
				[...acts.keys()].sort()
			);
			for (const button of buttons) {
				expect(button.tabIndex).toBe(0);
				expect(button.getAttribute("aria-label")).toStartWith(
					acts.get(button.dataset.actAgent ?? "")?.ariaLabel ?? "missing"
				);
				expect(button.hasAttribute("data-icon-only")).toBe(
					width < 640 && button.dataset.youSpot !== "slot"
				);
			}
			plates.unmount();
		});
	}

	test("a limited farmer sits on its own bench by the sundial, back at 15:10", () => {
		const fa = acts.get("fa");
		if (!fa) {
			throw new Error("missing Fa");
		}
		expect(benches.get("fa")).toBe("bench-0");
		const words = (item: typeof fa) =>
			limitWords(item, {
				clock: FIXTURE_CLOCK,
				limitText: farmLimitText,
				nowMs: FIXTURE_NOW,
			});
		expect(words(fa)).toBe("Back 15:10");
		expect(words({ ...fa, timer: null })).toBe("Resting");
		// A second limited farmer takes the next bench, not Fa's.
		const two = new Map(acts);
		const gu = acts.get("gu");
		if (gu) {
			two.set("gu", { ...gu, act: "limited" });
		}
		const seats = benchOf(diorama, two);
		expect(new Set([seats.get("fa"), seats.get("gu")]).size).toBe(2);
	});
});
