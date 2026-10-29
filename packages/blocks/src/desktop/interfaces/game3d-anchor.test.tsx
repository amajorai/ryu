import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// Words are drei `Html` overlays (DOM); these tests watch the scene graph.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({ ...drei, Html: () => null }));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const fiber = await import("@react-three/fiber");
const three = await import("three");
const { ...classes } = three;
fiber.extend(classes as unknown as Parameters<typeof fiber.extend>[0]);
const { CurvedAnchor } = await import("./game3d-anchor.tsx");
const { MeterText } = await import("./game3d-meters.tsx");
const { ApprenticeTally, apprenticeSpecs } = await import(
	"./game3d-apprentice.tsx"
);
const { CURVE_UNIFORMS, curveDrop } = await import("./game3d-toon.ts");
const { Villagers, villagerLooksFor } = await import("./game3d-villager.tsx");
const { agentSwatches } = await import("./game3d-palette.ts");

afterAll(() => {
	GlobalRegistrator.unregister();
});
const FLAT = {
	center: { ...CURVE_UNIFORMS.ryuCurveCenter.value },
	dir: { ...CURVE_UNIFORMS.ryuCurveDir.value },
};
afterEach(() => {
	CURVE_UNIFORMS.ryuCurve.value = 0;
	CURVE_UNIFORMS.ryuCurveCenter.value = { ...FLAT.center };
	CURVE_UNIFORMS.ryuCurveDir.value = { ...FLAT.dir };
});

/** An R3F root that draws nothing; frames run by hand. */
async function scene(node: ReactNode) {
	const canvas = document.createElement("canvas");
	const noop = () => undefined;
	const root = fiber.createRoot(canvas);
	await root.configure({
		events: undefined,
		frameloop: "never",
		gl: {
			domElement: canvas,
			getPixelRatio: () => 1,
			render: noop,
			setPixelRatio: noop,
			setSize: noop,
			shadowMap: { enabled: false },
			xr: {
				addEventListener: noop,
				enabled: false,
				isPresenting: false,
				removeEventListener: noop,
				setAnimationLoop: noop,
			},
		} as never,
		size: { height: 600, left: 0, top: 0, width: 800 },
	});
	await act(async () => {
		root.render(node);
	});
	const store = fiber._roots.get(canvas)?.store;
	if (!store) {
		throw new Error("no root");
	}
	let time = 0;
	return {
		frame() {
			time += 1 / 30;
			fiber.advance(time, true, store.getState());
		},
		scene: store.getState().scene,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
		},
	};
}

/** The world positions of every group with no children of its own but Html. */
function groupsNamed(
	root: { traverse: (visit: (node: unknown) => void) => void },
	name: string
) {
	const found: { x: number; y: number; z: number }[] = [];
	root.traverse((node) => {
		const group = node as InstanceType<typeof three.Group>;
		if (group.name === name) {
			const at = new three.Vector3();
			group.getWorldPosition(at);
			found.push({ x: at.x, y: at.y, z: at.z });
		}
	});
	return found;
}

/** A gentle curve along x, centred on the origin. */
function curveOn() {
	CURVE_UNIFORMS.ryuCurve.value = 0.01;
	CURVE_UNIFORMS.ryuCurveCenter.value = { x: 0, y: 0 };
	CURVE_UNIFORMS.ryuCurveDir.value = { x: 1, y: 0 };
}

describe("CurvedAnchor", () => {
	test("on a flat stage it stays where it is put", async () => {
		const stage = await scene(
			<CurvedAnchor position={[4, 1, 2]}>
				<group name="probe" />
			</CurvedAnchor>
		);
		stage.frame();
		expect(groupsNamed(stage.scene, "probe")).toEqual([{ x: 4, y: 1, z: 2 }]);
		await stage.unmount();
	});

	test("on a curved stage it drops with the ground under it", async () => {
		curveOn();
		const stage = await scene(
			<CurvedAnchor position={[4, 1, 2]}>
				<group name="probe" />
			</CurvedAnchor>
		);
		stage.frame();
		const [probe] = groupsNamed(stage.scene, "probe");
		expect(curveDrop(4, 2)).toBeGreaterThan(0);
		expect(probe?.y).toBeCloseTo(1 - curveDrop(4, 2), 6);
		await stage.unmount();
	});

	test("with follow it walks with the body and drops where the body is", async () => {
		curveOn();
		const body = { x: 6, z: -1 };
		const stage = await scene(
			<CurvedAnchor follow={() => body} position={[0, 1, 0]}>
				<group name="probe" />
			</CurvedAnchor>
		);
		stage.frame();
		let [probe] = groupsNamed(stage.scene, "probe");
		expect(probe?.x).toBe(6);
		expect(probe?.z).toBe(-1);
		expect(probe?.y).toBeCloseTo(1 - curveDrop(6, -1), 6);
		body.x = 2;
		stage.frame();
		[probe] = groupsNamed(stage.scene, "probe");
		expect(probe?.x).toBe(2);
		await stage.unmount();
	});
});

describe("curved words", () => {
	test("MeterText drops on a curved stage only when asked", async () => {
		curveOn();
		const stage = await scene(
			<>
				<MeterText at={[5, 1, 0]}>plain</MeterText>
				<MeterText at={[5, 1, 0]} curved>
					curved
				</MeterText>
			</>
		);
		stage.frame();
		const heights: number[] = [];
		stage.scene.traverse((node) => {
			const group = node as InstanceType<typeof three.Group>;
			if (group.type === "Group" && group.parent === stage.scene) {
				heights.push(group.position.y);
			}
		});
		expect(heights.sort()).toEqual([1 - curveDrop(5, 0), 1].sort());
		await stage.unmount();
	});

	test("ApprenticeTally keeps its words where they were; curved and follow move them", async () => {
		const helpers = { done: 0, failed: 1, running: 1, titles: [] };
		const tops = async (node: ReactNode) => {
			const stage = await scene(node);
			stage.frame();
			const at: { x: number; y: number; z: number }[] = [];
			stage.scene.traverse((node) => {
				const group = node as InstanceType<typeof three.Group>;
				if (group.type === "Group" && group.children.length === 0) {
					const point = new three.Vector3();
					group.getWorldPosition(point);
					at.push({ x: point.x, y: point.y, z: point.z });
				}
			});
			await stage.unmount();
			return at;
		};
		const flat = await tops(
			<ApprenticeTally helpers={helpers} station={[3, 0, 1]} />
		);
		// The failed helper's "×" sits at its spot, 1.05 up.
		expect(flat.length).toBeGreaterThan(0);
		for (const point of flat) {
			expect(point.y).toBeGreaterThan(0.5);
		}
		curveOn();
		const curved = await tops(
			<ApprenticeTally curved helpers={helpers} station={[3, 0, 1]} />
		);
		expect(curved.map((point) => point.y)).toEqual(
			flat.map((point) => point.y - curveDrop(3, 1))
		);
		const followed = await tops(
			<ApprenticeTally
				follow={() => ({ x: 10, z: 0 })}
				helpers={helpers}
				station={[3, 0, 1]}
			/>
		);
		expect(followed.map((point) => point.x)).toEqual(
			flat.map((point) => point.x - 3 + 10)
		);
	});
});

describe("villagers that follow a body", () => {
	const swatch = agentSwatches(["ada"]).get("ada");
	if (!swatch) {
		throw new Error("no swatch");
	}
	const looks = villagerLooksFor("ada", swatch);

	test("apprenticeSpecs hands follow on, with positions around the body", () => {
		const follow = () => ({ x: 7, z: 2 });
		const helpers = { done: 0, failed: 0, running: 2, titles: [] };
		const fixed = apprenticeSpecs({
			agentId: "ada",
			helpers,
			looks,
			station: [5, 0, 5],
		});
		const followed = apprenticeSpecs({
			agentId: "ada",
			follow,
			helpers,
			looks,
			station: [5, 0, 5],
		});
		expect(fixed.every((spec) => spec.follow === undefined)).toBe(true);
		expect(followed.every((spec) => spec.follow === follow)).toBe(true);
		for (const [index, spec] of followed.entries()) {
			const was = fixed[index]?.position ?? [0, 0, 0];
			expect(spec.position[0]).toBeCloseTo(was[0] - 5, 9);
			expect(spec.position[1]).toBe(was[1]);
			expect(spec.position[2]).toBeCloseTo(was[2] - 5, 9);
		}
	});

	test("a following villager is drawn offset by the body every frame", async () => {
		const body = { x: 5, z: -2 };
		const spec = (follow?: () => { x: number; z: number }) => ({
			follow,
			id: "ada",
			label: "Ada",
			looks,
			name: "Ada",
			pose: "idle" as const,
			position: [1, 0, 1] as [number, number, number],
		});
		const firstInstance = async (follow?: () => { x: number; z: number }) => {
			const stage = await scene(
				<Villagers plates={false} reducedMotion villagers={[spec(follow)]} />
			);
			stage.frame();
			stage.frame();
			let mesh: InstanceType<typeof three.InstancedMesh> | null = null;
			stage.scene.traverse((node) => {
				if (!mesh && (node as { isInstancedMesh?: boolean }).isInstancedMesh) {
					mesh = node as InstanceType<typeof three.InstancedMesh>;
				}
			});
			const matrix = new three.Matrix4();
			(mesh as InstanceType<typeof three.InstancedMesh> | null)?.getMatrixAt(
				0,
				matrix
			);
			const at = new three.Vector3().setFromMatrixPosition(matrix);
			await stage.unmount();
			return at;
		};
		const still = await firstInstance();
		const moved = await firstInstance(() => body);
		expect(moved.x - still.x).toBeCloseTo(5, 6);
		expect(moved.z - still.z).toBeCloseTo(-2, 6);
		expect(moved.y).toBeCloseTo(still.y, 6);
	});
});
