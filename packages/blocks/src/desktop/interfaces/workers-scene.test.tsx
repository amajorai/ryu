import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The scene's plates are drei `Html` overlays; outside a Canvas, render them
// in place, and give the frame hooks a still stage, so the act props' and
// markers' DOM (the keyboard and screen-reader targets) can be checked
// without WebGL.
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
const { actOverlays, overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { askOwners } = await import("./interface-ask-card.tsx");
const { limitWords } = await import("./game3d-act-stage.tsx");
const {
	coffeeOf,
	coffeeSpots,
	doorLayout,
	WorkerDeskActs,
	workerLimitText,
	WorkersDoorActs,
} = await import("./workers-acts.tsx");
const { deskLayout, WorkerMarkers } = await import("./workers-diorama.tsx");
const { ACT_SPREAD, actWorkers, buildWorkers, layoutOffice } = await import(
	"./workers-model.ts"
);

const SLAB = 0.16;
const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const staged = stageAgents(acts, Number.POSITIVE_INFINITY);
const slots = youSpotSlots(acts, unownedAsks(fixture));
const plan = layoutOffice(actWorkers(buildWorkers(fixture), acts), ACT_SPREAD);
const coffee = coffeeOf(plan, acts);
const spots = coffeeSpots(plan, SLAB);
const rests = new Map(
	[...coffee].map(([id, point]) => [
		id,
		spots[Number(point.slice("coffee-".length))] ?? null,
	])
);
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

/** The office's act targets as the diorama draws them at `width`. */
function office(width: number, opened: string[], selectedId: string | null) {
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
	const actScene = {
		acts,
		handlers,
		offStage: staged.offStage,
		onAsk: handlers.onAsk,
		onStage: staged.onStage,
		owners: askOwners(acts),
		slots,
	};
	return render(
		<div>
			{plan.desks.map((desk) => {
				const item = acts.get(desk.worker.id);
				return item ? (
					<WorkerDeskActs
						act={item}
						at={[desk.x, 0, desk.z]}
						handlers={handlers}
						key={desk.worker.id}
						layout={deskLayout(
							desk,
							rests.get(desk.worker.id) ?? null,
							plan.coffee
						)}
					/>
				) : null;
			})}
			<WorkersDoorActs
				handlers={handlers}
				layout={doorLayout(plan, SLAB, SLAB + 0.66)}
				offStage={staged.offStage}
				onStage={staged.onStage}
				owners={actScene.owners}
				slots={slots}
			/>
			<WorkerMarkers
				actScene={actScene}
				onOpenScreen={(id) => opened.push(`screen:${id}`)}
				onOpenWorker={(id) => opened.push(`desk:${id}`)}
				plan={plan}
				rests={rests}
				selectedId={selectedId}
			/>
		</div>
	);
}

const plateOf = (container: HTMLElement, agentId: string) =>
	container.querySelector<HTMLElement>(`[data-act-agent='${agentId}']`);

describe("workers scene targets", () => {
	test("15b: Ada's name plate answers her ask; Cy's opens the desk; the desk props open their cards", () => {
		const opened: string[] = [];
		const view = office(1280, opened, "cy");
		const ada = plateOf(view.container, "ada");
		expect(ada?.getAttribute("aria-label")).toBe(`${ADA} Answer their ask.`);
		expect(ada?.getAttribute("aria-pressed")).toBeNull();
		expect(ada?.getAttribute("aria-label")).not.toContain("Waiting on you");
		act(() => ada?.click());
		expect(opened).toEqual(["approval:ada-shell"]);
		const cy = plateOf(view.container, "cy");
		expect(cy?.getAttribute("aria-label")).toBe(
			`${acts.get("cy")?.ariaLabel} Open their desk.`
		);
		expect(cy?.getAttribute("aria-pressed")).toBe("true");
		act(() => cy?.click());
		expect(opened.at(-1)).toBe("desk:cy");
		// No screen says "Idle" over a desk (Ju's answer and Ha's suggestion
		// wait there): an idle screen shows its task or nothing.
		const screens = [
			...view.container.querySelectorAll<HTMLElement>(
				'[aria-label*="\'s screen: "]'
			),
		];
		expect(screens.length).toBeGreaterThan(0);
		for (const screen of screens) {
			expect(screen.textContent ?? "").not.toContain("Idle");
			expect(screen.getAttribute("aria-label") ?? "").not.toContain("Idle");
		}
		const target = (kind: string) => [
			...view.container.querySelectorAll<HTMLElement>(
				`[data-act-target='${kind}']`
			),
		];
		// Di's two alarms (and Ed's interruption) are focusable scene targets.
		const alarms = target("alarm");
		expect(alarms).toHaveLength(3);
		expect(
			alarms.filter((alarm) =>
				alarm.getAttribute("aria-label")?.startsWith("Di")
			)
		).toHaveLength(2);
		for (const alarm of alarms) {
			expect(alarm.hasAttribute("data-iso-target")).toBe(true);
		}
		act(() => target("tray")[0]?.click());
		act(() => target("unread")[0]?.click());
		act(() => target("suggestion")[0]?.click());
		expect(opened.slice(-3)).toEqual([
			"reply:t-gu",
			"reply:t-ju",
			"approval:heal-digest",
		]);
		view.unmount();
	});

	for (const width of [1280, 390]) {
		test(`21: every exempt target is rendered and focusable at ${width}`, () => {
			const view = office(width, [], null);
			const props = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-target]"),
			];
			const kinds = props.map((item) => item.dataset.actTarget);
			expect(kinds.filter((kind) => kind === "alarm")).toHaveLength(3);
			expect(kinds.filter((kind) => kind === "notice")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "tray")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "unread")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "suggestion")).toHaveLength(1);
			for (const item of props) {
				expect(item.tabIndex).toBe(0);
				expect(item.hasAttribute("data-iso-target")).toBe(true);
				expect(item.hasAttribute("data-icon-only")).toBe(
					width < 640 && item.dataset.actTarget !== "notice"
				);
			}
			const plates = [
				...view.container.querySelectorAll<HTMLElement>("[data-act-agent]"),
			];
			// The door's queue: Ada and Bo carry their asks, the gate's notice waits.
			expect(
				view.container.querySelectorAll("[data-you-spot='slot']")
			).toHaveLength(3);
			// One name plate per agent, each its one Tab stop.
			expect(plates.map((plate) => plate.dataset.actAgent).sort()).toEqual(
				[...acts.keys()].sort()
			);
			for (const plate of plates) {
				expect(plate.tabIndex).toBe(0);
				const queued = plate.dataset.youSpot === "slot";
				expect(plate.hasAttribute("data-icon-only")).toBe(
					width < 640 && !queued
				);
				expect(plate.getAttribute("aria-label")).toStartWith(
					acts.get(plate.dataset.actAgent ?? "")?.ariaLabel ?? "missing"
				);
			}
			// Screens carry the activity with the worker's name, out of the Tab order.
			const screens = [
				...view.container.querySelectorAll<HTMLElement>("button"),
			].filter((button) =>
				button.getAttribute("aria-label")?.includes("'s screen:")
			);
			expect(screens).toHaveLength(acts.size);
			for (const screen of screens) {
				expect(screen.tabIndex).toBe(-1);
			}
			expect(
				screens.map((screen) => screen.getAttribute("aria-label"))
			).toContain("Cy's screen: Editing snapshot.ts. Open the task");
			view.unmount();
		});
	}

	test("a limited worker's plate follows it to the coffee corner; its mug says when it is back", () => {
		const fa = acts.get("fa");
		if (!fa) {
			throw new Error("missing Fa");
		}
		const rest = rests.get("fa");
		const desk = plan.desks.find((item) => item.worker.id === "fa");
		if (!(rest && desk)) {
			throw new Error("Fa should rest in the coffee corner");
		}
		// The words and the mug stand with Fa in the corner, not at the desk.
		expect(Math.hypot(desk.x - rest[0], desk.z - rest[2])).toBeGreaterThan(4);
		const layout = deskLayout(desk, rest, plan.coffee);
		for (const piece of [layout.board, layout.limit]) {
			const at = [desk.x + (piece?.[0] ?? 0), desk.z + (piece?.[2] ?? 0)];
			expect(
				Math.hypot((at[0] ?? 0) - rest[0], (at[1] ?? 0) - rest[2])
			).toBeLessThan(2);
		}
		const words = (item: typeof fa) =>
			limitWords(item, {
				clock: FIXTURE_CLOCK,
				limitText: workerLimitText,
				nowMs: FIXTURE_NOW,
			});
		expect(words(fa)).toBe("Back 15:10");
		expect(words({ ...fa, timer: null })).toBe("On a break");
	});
});
