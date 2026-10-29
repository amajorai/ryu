import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The picker plates are drei `Html` overlays: outside a Canvas, render them
// in place (this file's own mock, so the other Warehouse suites keep the
// real module), with a DOM registered before React loads.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));

const registered = globalThis.document === undefined;
if (registered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registered) {
		await GlobalRegistrator.unregister();
	}
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} = await import("./game-acts-fixture.ts");
const { youSpotSlots } = await import("./game3d-acts.ts");
const { VillagerPlate } = await import("./game3d-villager.tsx");
const { actPickers, pickerStations, warehouseActPaths } = await import(
	"./warehouse-acts.tsx"
);
const { buildPickers } = await import("./warehouse-model.ts");

type Spec = ReturnType<typeof actPickers>[number];

describe("Warehouse picker plates (15a)", () => {
	const snapshot = usefulStateFixture();
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const stations = pickerStations(buildPickers(snapshot.agents, []));
	const opened: string[] = [];
	const cast = actPickers({
		acts,
		looks: new Map(
			Object.values(FIXTURE_AGENT_IDS).map((id) => [id, {} as never])
		),
		nowMs: FIXTURE_NOW,
		onAsk: (askId) => opened.push(askId),
		paths: warehouseActPaths(stations),
		reduced: true,
		shown: new Set(),
		slots: youSpotSlots(acts, unownedAsks(snapshot)).slots,
		stations,
	});
	const specOf = (id: string): Spec => {
		const spec = cast.find((candidate) => candidate.actAgent === id);
		if (!spec) {
			throw new Error(`no spec for ${id}`);
		}
		return spec;
	};

	/** Renders a plate as the floor does (its onSelect is the floor's onSelectPicker) and clicks it. */
	const clickPlate = async (
		spec: Spec,
		onSelectPicker: (id: string) => void
	) => {
		const holder = document.createElement("div");
		document.body.append(holder);
		const root = createRoot(holder);
		await act(async () => {
			root.render(
				<VillagerPlate onSelect={onSelectPicker} selected={false} spec={spec} />
			);
		});
		const button = holder.querySelector("button");
		if (!button) {
			throw new Error("no plate button");
		}
		const attributes = {
			pressed: button.getAttribute("aria-pressed"),
			tabIndex: button.getAttribute("tabindex"),
		};
		await act(async () => {
			button.click();
		});
		await act(async () => {
			root.unmount();
		});
		holder.remove();
		return attributes;
	};

	test("Ada's plate opens her ask, not the floor's picker filter", async () => {
		opened.length = 0;
		const picked: string[] = [];
		const ada = await clickPlate(specOf(FIXTURE_AGENT_IDS.ada), (id) =>
			picked.push(id)
		);
		expect(opened).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		expect(picked).toEqual([]);
		// A Tab stop without aria-pressed (activate replaces onSelect).
		expect(ada).toEqual({ pressed: null, tabIndex: "0" });
	});

	test("Cy's plate keeps the floor's onSelectPicker and aria-pressed", async () => {
		opened.length = 0;
		const picked: string[] = [];
		const cy = await clickPlate(specOf(FIXTURE_AGENT_IDS.cy), (id) =>
			picked.push(id)
		);
		expect(picked).toEqual([FIXTURE_AGENT_IDS.cy]);
		expect(opened).toEqual([]);
		expect(cy).toEqual({ pressed: "false", tabIndex: "0" });
	});
});
