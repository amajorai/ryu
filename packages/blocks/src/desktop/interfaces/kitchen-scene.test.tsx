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
const { actOverlays, askOwners, overlayBudget, stageAgents, youSpotSlots } =
	await import("./game3d-acts.ts").then(async (acts) => ({
		...acts,
		askOwners: (await import("./interface-ask-card.tsx")).askOwners,
	}));
const { VillagerPlate } = await import("./game3d-villager.tsx");
const {
	kitchenActVillagers,
	KitchenPassActs,
	KitchenStationActs,
	eightySixed,
} = await import("./kitchen-acts.tsx");
const { ACT_SPREAD, buildService, floorCentreZ } = await import(
	"./kitchen-model.ts"
);
const { kitchenPaths } = await import("./kitchen-acts.tsx");
const { EMPTY_THEME, kitchenPalette } = await import("./kitchen-palette.ts");

const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const unowned = unownedAsks(fixture);
const service = buildService(fixture, FIXTURE_NOW, 4, ACT_SPREAD);
const staged = stageAgents(acts, Number.POSITIVE_INFINITY);
const slots = youSpotSlots(acts, unowned);
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

const LOOKS = {
	body: "x",
	collar: "x",
	hair: "x",
	hairStyle: 0,
	iris: "x",
	skin: "x",
};

/** The budget's choice at `width`, as the interface makes it. */
function budgetAt(width: number) {
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(
		actOverlays(
			staged.onStage,
			slots,
			staged.offStage,
			staged.onStage.find((item) => item.act === "working")?.agentId ?? null,
			{ reduced: true }
		)
	);
	return { iconOnly: budget.iconOnly, shown };
}

/** The chefs as the diorama casts them. */
function chefs(shown: ReadonlySet<string>, opened: string[]) {
	return kitchenActVillagers({
		acts,
		centreZ: floorCentreZ(service.floor),
		looks: new Map(fixture.agents.map((agent) => [agent.id, LOOKS])),
		nowMs: FIXTURE_NOW,
		onAsk: (askId) => opened.push(askId),
		paths: kitchenPaths(service, floorCentreZ(service.floor), 0.16),
		reduced: true,
		service,
		shown,
		slab: 0.16,
		slots: slots.slots,
	}).filter((spec) => !spec.id.includes(":helper:"));
}

/** Every act prop of the kitchen, as the diorama draws them at `width`. */
function scene(width: number, opened: string[]) {
	const { iconOnly, shown } = budgetAt(width);
	const budget = { iconOnly };
	const handlers = {
		clock: FIXTURE_CLOCK,
		iconOnly: budget.iconOnly,
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
		<>
			{service.stations.map((station) => {
				const act = acts.get(station.agent.id);
				return act ? (
					<KitchenStationActs
						act={act}
						handlers={handlers}
						key={station.agent.id}
						station={station}
					/>
				) : null;
			})}
			<KitchenPassActs
				handlers={handlers}
				offStage={staged.offStage}
				onStage={staged.onStage}
				owners={askOwners(acts)}
				palette={kitchenPalette(EMPTY_THEME)}
				passTop={0.66}
				service={service}
				slots={slots}
			/>
		</>
	);
}

describe("kitchen scene targets", () => {
	test("15a: Ada's plate answers her ask (no aria-pressed); Cy's keeps the selection", () => {
		const opened: string[] = [];
		const specs = chefs(new Set(), opened);
		const ada = specs.find((spec) => spec.id === "ada");
		const cy = specs.find((spec) => spec.id === "cy");
		if (!(ada && cy)) {
			throw new Error("missing chefs");
		}
		const selected: string[] = [];
		const adaPlate = render(
			<VillagerPlate onSelect={(id) => selected.push(id)} selected spec={ada} />
		);
		const adaButton = adaPlate.container.querySelector("button");
		expect(adaButton?.getAttribute("aria-label")).toBe(
			`${ADA} Answer their ask.`
		);
		expect(adaButton?.getAttribute("aria-pressed")).toBeNull();
		expect(adaButton?.tabIndex).toBe(0);
		expect(adaButton?.getAttribute("data-you-spot")).toBe("slot");
		act(() => adaButton?.click());
		expect(opened).toEqual(["approval:ada-shell"]);
		expect(selected).toEqual([]);
		adaPlate.unmount();
		const cyPlate = render(
			<VillagerPlate
				onSelect={(id) => selected.push(id)}
				selected={false}
				spec={cy}
			/>
		);
		const cyButton = cyPlate.container.querySelector("button");
		expect(cyButton?.getAttribute("aria-label")).toBe(
			`${acts.get("cy")?.ariaLabel} Open their tickets.`
		);
		expect(cyButton?.getAttribute("aria-pressed")).toBe("false");
		act(() => cyButton?.click());
		expect(selected).toEqual(["cy"]);
		cyPlate.unmount();
	});

	for (const width of [1280, 390]) {
		test(`21: every exempt target is rendered and focusable at ${width}`, () => {
			const opened: string[] = [];
			const view = scene(width, opened);
			const targets = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-target]"),
			];
			const kinds = targets.map((target) => target.dataset.actTarget);
			// Di's two alarms and Ed's; the workflow gate's notice; Gu's dish;
			// Ju's unread mark; Ha's suggestion note.
			expect(kinds.filter((kind) => kind === "alarm")).toHaveLength(3);
			expect(kinds.filter((kind) => kind === "notice")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "tray")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "unread")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "suggestion")).toHaveLength(1);
			for (const target of targets) {
				expect(target.tabIndex).toBe(0);
				expect(target.hasAttribute("data-iso-target")).toBe(true);
				expect(target.getAttribute("aria-label")?.length).toBeGreaterThan(10);
				// On a phone the openers are glyphs (the queue's notice keeps its words).
				const iconOnly = target.hasAttribute("data-icon-only");
				expect(iconOnly).toBe(
					width < 640 && target.dataset.actTarget !== "notice"
				);
			}
			const notice = targets.find(
				(target) => target.dataset.actTarget === "notice"
			);
			expect(notice?.getAttribute("aria-label")).toBe(
				"Inbox asks: Workflow gate: Deploy. Waited 20 minutes. Risk: workflow."
			);
			const tray = targets.find(
				(target) => target.dataset.actTarget === "tray"
			);
			act(() => tray?.click());
			expect(opened).toEqual(["reply:t-gu"]);
			view.unmount();
		});

		test(`21: every chef's plate is rendered and focusable at ${width}, queue plates keep their words`, () => {
			const { iconOnly, shown } = budgetAt(width);
			const specs = chefs(shown, []);
			expect(specs.map((spec) => spec.id).sort()).toEqual(
				[...acts.keys()].sort()
			);
			const view = render(
				<div>
					{specs.map((spec) => (
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
			const plates = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-agent]"),
			];
			expect(plates).toHaveLength(acts.size);
			const queued = plates.filter((plate) => plate.dataset.youSpot === "slot");
			// Ada and Bo carry their asks to the pass (the gate's notice is the third).
			expect(queued.map((plate) => plate.dataset.actAgent).sort()).toEqual([
				"ada",
				"bo",
			]);
			for (const plate of plates) {
				const agent = acts.get(plate.dataset.actAgent ?? "");
				expect(plate.tabIndex).toBe(0);
				expect(plate.getAttribute("aria-label")).toStartWith(
					agent?.ariaLabel ?? "missing"
				);
				expect(plate.hasAttribute("data-icon-only")).toBe(
					width < 640 && plate.dataset.youSpot !== "slot"
				);
			}
			view.unmount();
		});
	}

	test("the limit reads in kitchen words, from when it resets", () => {
		const fa = acts.get("fa");
		if (!fa) {
			throw new Error("missing Fa");
		}
		expect(eightySixed(fa, FIXTURE_NOW, FIXTURE_CLOCK)).toBe("86'd till 15:10");
		expect(
			eightySixed(
				{
					...fa,
					blockers: [
						{
							clearsAt: "2026-10-16T15:10:00.000Z",
							kind: "rate-limited",
							source: "estimate",
							title: "Limit hit",
						},
					],
				},
				FIXTURE_NOW,
				FIXTURE_CLOCK
			)
		).toBe("Likely 86'd till 15:10");
		expect(
			eightySixed({ ...fa, timer: null }, FIXTURE_NOW, FIXTURE_CLOCK)
		).toBe("86'd");
	});
});
