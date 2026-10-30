/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import { Check, Ellipsis, Hourglass, Reply, Star } from "lucide-react";
import { type ReactNode, useRef } from "react";
import type { Group } from "three";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import {
	MASCOT_SCALE,
	needsYou,
	PAD_HEIGHT,
	VILLAGER_HEIGHT,
} from "./path-diorama-parts.ts";
import { PATH_3D } from "./path-palette.ts";
import { stopTitle } from "./path-stop.tsx";
import type { PathWorld, WorldStone } from "./path-world.ts";

/** The Path diorama's plates: the "!" over a pad and each marker's mark and lift. */

/** A red "!" bobbing over a pad that needs you (still under reduced motion). */
export function Exclaim({
	at,
	reducedMotion,
}: {
	at: Vec3;
	reducedMotion: boolean;
}) {
	const ref = useRef<Group>(null);
	useFrame(({ clock }) => {
		const group = ref.current;
		if (!group || reducedMotion) {
			return;
		}
		group.position.y =
			at[1] + Math.abs(Math.sin(clock.elapsedTime * 3.2)) * 0.22;
	});
	return (
		<group position={at} ref={ref} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh
				castShadow
				color={PATH_3D.attention}
				ink={PROP_INK}
				position={[0, 0.34, 0]}
			>
				<boxGeometry args={[0.13, 0.4, 0.13]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={PATH_3D.attention}
				ink={PROP_INK}
				position={[0, 0.04, 0]}
			>
				<sphereGeometry args={[0.085, 12, 10]} />
			</ToonMesh>
		</group>
	);
}

/** The marker over a pad: its state's mark, and whether its title is pinned. */
export function stoneMark(stone: WorldStone): {
	body: ReactNode;
	className?: string;
	pinned: boolean;
} {
	const { state } = stone.stop;
	const icon = "size-3.5 shrink-0";
	const pinned = state === "current" || needsYou(state);
	switch (state) {
		case "current":
			return {
				body: <Star aria-hidden="true" className={`${icon} fill-current`} />,
				className: "bg-(--gk-warn) text-(--gk-edge) h-8 text-[14px]",
				pinned,
			};
		case "attention":
			return {
				body: (
					<span aria-hidden="true" className="px-0.5 font-black">
						!
					</span>
				),
				className: "bg-(--gk-bad) text-white",
				pinned,
			};
		case "done":
			return {
				body: <Check aria-hidden="true" className={icon} strokeWidth={3.5} />,
				className: "bg-(--gk-gold) text-(--gk-edge)",
				pinned,
			};
		case "reply":
			return {
				body: <Reply aria-hidden="true" className={icon} strokeWidth={3} />,
				className: "bg-(--gk-info) text-white",
				pinned,
			};
		case "working":
			return {
				body: <Ellipsis aria-hidden="true" className={icon} strokeWidth={3} />,
				className: "bg-(--gk-good) text-white",
				pinned,
			};
		case "waiting":
			return {
				body: (
					<Hourglass aria-hidden="true" className={icon} strokeWidth={2.75} />
				),
				className: "text-(--gk-ink-muted)",
				pinned,
			};
		default:
			return {
				body: <Star aria-hidden="true" className={icon} strokeWidth={2.75} />,
				className: "text-(--gk-ink-muted)",
				pinned,
			};
	}
}

/** A stone's mark height with acts: just over the pad. */
export const ACT_STONE_LIFT = PAD_HEIGHT + 0.3;

/** How high a stop's plate floats: over the mascot's head on the current one. */
export function plateLift(stone: WorldStone): number {
	return stone.stop.state === "current"
		? PAD_HEIGHT + VILLAGER_HEIGHT * MASCOT_SCALE + 0.45
		: PAD_HEIGHT + 0.62;
}

/** The camera's pitch, for guessing where plates land on screen. */
const PITCH = 0.56;
/** Roughly how wide a plate is, in world units, for so many characters. */
const plateWidth = (characters: number) => 0.9 + characters * 0.13;

/** Where a world point lands on screen, in world units (camera at 45°). */
function onScreen(x: number, y: number, z: number): [number, number] {
	return [
		(x - z) * Math.SQRT1_2,
		y * Math.cos(PITCH) - (x + z) * Math.SQRT1_2 * Math.sin(PITCH),
	];
}

/**
 * The signposts whose plates would land on a stop plate that is always
 * shown: those keep only their number and "+", their name on hover and
 * focus, so the plates never stack.
 */
export function crowdedSigns(world: PathWorld): Set<string> {
	const pinned = world.stones
		.filter(
			(stone) => stone.stop.state === "current" || needsYou(stone.stop.state)
		)
		.map((stone) => {
			const [sx, sy] = onScreen(
				stone.at[0],
				stone.y + plateLift(stone),
				stone.at[1]
			);
			const characters = Math.min(26, stopTitle(stone.stop).length + 8);
			return { sx, sy, width: plateWidth(characters) };
		});
	const crowded = new Set<string>();
	for (const sign of world.signs) {
		const [sx, sy] = onScreen(sign.at[0], sign.y + 1.06, sign.at[1]);
		const width = plateWidth(sign.unit.title.length + 3);
		const hit = pinned.some(
			(plate) =>
				Math.abs(plate.sx - sx) < (plate.width + width) / 2 &&
				Math.abs(plate.sy - sy) < 0.62
		);
		if (hit) {
			crowded.add(sign.unit.id);
		}
	}
	return crowded;
}

/** Shows a plate's title on hover and focus (pinned plates always show it). */
export const REVEAL_TITLE =
	"[&:is(:hover,:focus-visible)_[data-plate-title]]:inline";
