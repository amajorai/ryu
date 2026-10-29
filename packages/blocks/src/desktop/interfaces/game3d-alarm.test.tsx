import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InterfaceBlocker } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";

// Alarms render meshes and drei plates; outside a Canvas keep only the plates.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
const fiber = await import("@react-three/fiber");
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: () => undefined,
}));
const materials = await import("./game3d-materials.tsx");
mock.module("./game3d-materials.tsx", () => ({
	...materials,
	ToonMesh: () => null,
}));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AlarmStack, alarmRows, alarmSideFor } = await import(
	"./game3d-alarm.tsx"
);
const { PLATE_ROW_GAP } = await import("./game3d-signs.tsx");

afterAll(() => {
	GlobalRegistrator.unregister();
});

const BLOCKERS: InterfaceBlocker[] = [
	{
		at: "2026-10-17T12:40:00Z",
		kind: "command-failed",
		source: "messages",
		title: "Tests failed",
	},
	{
		at: "2026-10-17T07:00:00Z",
		kind: "schedule-failed",
		source: "messages",
		title: "Nightly backup failed",
	},
];

function plateTransforms(node: ReactNode): string[] {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(node));
	const transforms = [...container.querySelectorAll("button")].map(
		(button) => button.parentElement?.style.transform ?? ""
	);
	act(() => root.unmount());
	container.remove();
	return transforms;
}

const stack = (extra: Record<string, unknown>) => (
	<AlarmStack
		agentName="Di"
		at={[0, 0, 0]}
		blockers={BLOCKERS}
		focusable
		nowMs={Date.parse("2026-10-17T13:00:00Z")}
		onOpen={() => undefined}
		reducedMotion
		{...extra}
	/>
);

const row = (side: string, rows: number) => {
	const lift = `${rows} * (100% + ${PLATE_ROW_GAP}px)`;
	if (side === "right") {
		return `translate(0, calc(-50% - ${lift}))`;
	}
	if (side === "left") {
		return `translate(-100%, calc(-50% - ${lift}))`;
	}
	return `translateY(calc(0px - ${lift}))`;
};

describe("AlarmStack plates", () => {
	test("with the default step, plate i climbs i rows on the given side", () => {
		expect(plateTransforms(stack({ side: "right" }))).toEqual([
			row("right", 0),
			row("right", 1),
		]);
		expect(plateTransforms(stack({ side: "left" }))).toEqual([
			row("left", 0),
			row("left", 1),
		]);
		// Centred, the focus plate needs no wrapper; the next climbs a row.
		expect(plateTransforms(stack({}))).toEqual(["", row("center", 1)]);
	});

	test("a game's own step is the whole climb: no row lift on top", () => {
		expect(
			plateTransforms(stack({ side: "right", step: [0, 0.55, 0] }))
		).toEqual([row("right", 0), row("right", 0)]);
	});

	test("rows overrides: -1 steps a row down per alarm", () => {
		expect(
			plateTransforms(stack({ rows: -1, side: "right", step: [0, 0.8, 0] }))
		).toEqual([row("right", 0), row("right", -1)]);
		expect(plateTransforms(stack({ rows: -1, side: "left" }))).toEqual([
			row("left", 0),
			row("left", -1),
		]);
	});
});

describe("alarm side and rows", () => {
	test("the side follows where the alarms sit, centred near the figure", () => {
		expect(alarmSideFor([0.75, 0, -0.75])).toBe("right");
		expect(alarmSideFor([-0.8, -0.45, 1.2])).toBe("left");
		expect(alarmSideFor([-1.3, 0, 0.1])).toBe("left");
		expect(alarmSideFor([0.4, 0, 0.4])).toBe("center");
		expect(alarmSideFor([0, 0, 0])).toBe("center");
	});

	test("rows: one with the default step, none with a custom step", () => {
		expect(alarmRows([0, 0, 0])).toBe(1);
		expect(alarmRows([0, 0.6, 0])).toBe(0);
		expect(alarmRows([0, 0.6, 0], -1)).toBe(-1);
		expect(alarmRows([0, 0, 0], 0)).toBe(0);
	});
});
