/* eslint-disable react/no-unknown-property */
import { type Camera, useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Euler, InstancedMesh, Matrix4, Vector3 } from "three";
import { shareHull } from "./game3d-instances.tsx";
import { InkMaterial } from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import { BODY_Y, type MemberLooks } from "./game3d-villager-model.ts";
import {
	limbOf,
	localMatrices,
	PART_GROUPS,
	type PartGroup,
	PartMaterial,
	PartShape,
	partShown,
} from "./game3d-villager-shape.tsx";

/** A villager's pose for one frame, written by `VillagerRig`'s caller. */
export interface RigPose {
	/** Forward swing of each arm about the shoulder (negative lifts it). */
	armLeft: number;
	armRight: number;
	/** Both hands hold a carried item: the held tool is put away. */
	holding?: boolean;
	/** Where the feet stand. */
	position: Vector3;
	/** Lean (x), facing (y) and sway (z). */
	rotation: Euler;
	scale: Vector3;
}

export interface RigFrame {
	camera: Camera;
	delta: number;
	time: number;
}

/** The shoulder the arms swing about, in the rig's local space. */
const SHOULDER_X = 0.15;
const SHOULDER_Y = BODY_Y + 0.1;

interface RigScratch {
	arms: Matrix4[][];
	holding: boolean[];
	pivot: Matrix4;
	pose: RigPose;
	roots: Matrix4[];
	swing: Matrix4;
}

/**
 * Every villager as instanced body parts. Each frame `pose` writes each
 * villager's root transform and arm swings; every part's local transform
 * is composed on top. Only the part groups some villager shows are drawn.
 */
export function VillagerRig({
	members,
	onHover,
	onPick,
	pose,
}: {
	members: readonly MemberLooks[];
	onHover?: (index: number | null) => void;
	onPick?: (index: number) => void;
	pose: (index: number, out: RigPose, frame: RigFrame) => void;
}) {
	const groups = useMemo(
		() =>
			PART_GROUPS.filter((group) =>
				members.some((looks) =>
					group.parts.some((part) => partShown(part, looks))
				)
			),
		[members]
	);
	const shown = useMemo(
		() =>
			groups.map((group) =>
				members.flatMap((looks) =>
					group.parts.map((part) => partShown(part, looks))
				)
			),
		[groups, members]
	);
	const meshes = useRef<(InstancedMesh | null)[]>([]);
	const hulls = useRef<(InstancedMesh | null)[]>([]);
	const locals = useRef<Matrix4[][]>([]);
	const scratch = useRef<RigScratch | null>(null);

	// Colors only change when the cast changes; outlines share each part's
	// transforms and colors.
	useLayoutEffect(() => {
		locals.current = [];
		const cleanups: (() => void)[] = [];
		for (const [index, group] of groups.entries()) {
			const mesh = meshes.current[index];
			const color = mesh ? mathKit(mesh).color : null;
			if (!(mesh && color)) {
				continue;
			}
			let slot = 0;
			for (const looks of members) {
				for (const part of group.parts) {
					mesh.setColorAt(slot, color.set(part.color(looks)));
					slot += 1;
				}
			}
			if (mesh.instanceColor) {
				mesh.instanceColor.needsUpdate = true;
			}
			const hull = hulls.current[index];
			if (hull) {
				cleanups.push(shareHull(mesh, hull));
			}
		}
		return () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, [groups, members]);

	useFrame(({ camera, clock }, delta) => {
		const first = meshes.current.find(Boolean);
		if (!first) {
			return;
		}
		const kit = mathKit(first);
		scratch.current ??= {
			arms: [],
			holding: [],
			pivot: first.matrix.clone(),
			pose: {
				armLeft: 0,
				armRight: 0,
				position: kit.position.clone(),
				rotation: kit.euler.clone(),
				scale: kit.scale.clone(),
			},
			roots: [],
			swing: first.matrix.clone(),
		};
		const { arms, holding, pivot, pose: out, roots, swing } = scratch.current;
		const frame: RigFrame = { camera, delta, time: clock.elapsedTime };
		for (let index = 0; index < members.length; index++) {
			out.position.set(0, 0, 0);
			out.rotation.set(0, 0, 0);
			out.scale.set(1, 1, 1);
			out.armLeft = 0;
			out.armRight = 0;
			out.holding = false;
			pose(index, out, frame);
			holding[index] = out.holding;
			kit.quaternion.setFromEuler(out.rotation);
			const root = roots[index] ?? first.matrix.clone();
			roots[index] = root.compose(out.position, kit.quaternion, out.scale);
			const pair = arms[index] ?? [first.matrix.clone(), first.matrix.clone()];
			arms[index] = pair;
			for (const [side, angle] of [out.armLeft, out.armRight].entries()) {
				const limb = pair[side];
				if (!limb) {
					continue;
				}
				limb.copy(root);
				if (angle === 0) {
					continue;
				}
				const x = side === 0 ? -SHOULDER_X : SHOULDER_X;
				limb.multiply(pivot.makeTranslation(x, SHOULDER_Y, 0));
				limb.multiply(swing.makeRotationX(angle));
				limb.multiply(pivot.makeTranslation(-x, -SHOULDER_Y, 0));
			}
		}
		for (const [index, group] of groups.entries()) {
			const mesh = meshes.current[index];
			if (!mesh) {
				continue;
			}
			const parts = locals.current[index] ?? localMatrices(mesh, group);
			locals.current[index] = parts;
			const visible = shown[index] ?? [];
			const { matrix } = mathKit(mesh);
			let slot = 0;
			for (let member = 0; member < members.length; member++) {
				const root = roots[member];
				for (const [part, local] of parts.entries()) {
					const spec = group.parts[part];
					const limb = spec ? limbOf(spec) : null;
					let base = root;
					if (limb) {
						base = arms[member]?.[limb === "left" ? 0 : 1] ?? root;
					}
					// A held tool is put away while both hands carry something.
					const stowed =
						holding[member] === true && spec?.limb === "right" && spec.when;
					if (base && visible[slot] && !stowed) {
						matrix.multiplyMatrices(base, local);
					} else {
						matrix.makeScale(0, 0, 0);
					}
					mesh.setMatrixAt(slot, matrix);
					slot += 1;
				}
			}
			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();
		}
	});

	if (members.length === 0) {
		return null;
	}
	const memberAt = (group: PartGroup, instanceId: number | undefined) =>
		Math.floor((instanceId ?? 0) / group.parts.length);
	return (
		<group>
			{groups.map((group, index) => {
				const count = members.length * group.parts.length;
				return (
					<group key={`${group.kind}:${members.length}`}>
						<instancedMesh
							args={[undefined, undefined, count]}
							castShadow={group.shadow}
							onClick={
								onPick
									? (event) => {
											event.stopPropagation();
											onPick(memberAt(group, event.instanceId));
										}
									: undefined
							}
							onPointerOut={onHover ? () => onHover(null) : undefined}
							onPointerOver={
								onHover
									? (event) => {
											event.stopPropagation();
											onHover(memberAt(group, event.instanceId));
										}
									: undefined
							}
							ref={(mesh) => {
								meshes.current[index] = mesh;
							}}
						>
							<PartShape kind={group.kind} />
							<PartMaterial kind={group.kind} />
						</instancedMesh>
						{group.ink > 0 ? (
							<instancedMesh
								args={[undefined, undefined, count]}
								ref={(mesh) => {
									hulls.current[index] = mesh;
								}}
							>
								<InkMaterial width={group.ink} />
							</instancedMesh>
						) : (
							<FreeHullSlot index={index} slots={hulls} />
						)}
					</group>
				);
			})}
		</group>
	);
}

/** Clears a group's hull slot when that group draws no outline. */
function FreeHullSlot({
	index,
	slots,
}: {
	index: number;
	slots: { current: (InstancedMesh | null)[] };
}) {
	useLayoutEffect(() => {
		slots.current[index] = null;
	}, [index, slots]);
	return null;
}
