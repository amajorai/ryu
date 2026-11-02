import { useThree } from "@react-three/fiber";
import type {
	InterfaceAgentAct,
	World3dParams,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { actBubble, bubbleOverlayId } from "./game3d-acts.ts";
import type { LifeBubble } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { WorldActView } from "./world-3d-acts.tsx";
import {
	focusEye,
	houseBoxes,
	occludingHouses,
	pairCenter,
	type TreeObstacle,
	treesInShot,
} from "./world-3d-focus.ts";
import {
	type CameraFocus,
	focusDistance,
	type IsoFrame,
	uncoveredSize,
	type ViewShift,
} from "./world-3d-scene.tsx";
import type { SpreadVillage } from "./world-3d-spread.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import type { CrowdMember } from "./world-3d-villagers.tsx";

/** The rig's body language for an act (none for the rest). */
export function bodyLanguage(
	act: InterfaceAgentAct | undefined
): CrowdMember["act"] {
	if (act?.act === "asking" || act?.act === "limited") {
		return act.act;
	}
	if (act?.act === "blocked" && act.blockers[0]?.kind !== "interrupted") {
		return "blocked";
	}
	return undefined;
}

/** How far the characters stand above the ground, in tiles. */
export const CHARACTER_LIFT = 0.05;

const NO_GHOSTS: ReadonlySet<string> = new Set();
/** Margin around the cottages the isometric view keeps in frame, in tiles. */
const ISO_MARGIN = 1.5;

/** The cottages, their doorsteps and the spawn point: what isometric fits. */
export function villageFrame({ layout, village }: SpreadVillage): IsoFrame {
	const points: [number, number][] = [];
	for (const box of houseBoxes(layout, village.houses)) {
		points.push(
			[box.minX, box.minZ],
			[box.maxX, box.minZ],
			[box.minX, box.maxZ],
			// Agents stand on the doorstep, a tile in front of the cottage.
			[box.maxX, box.maxZ + 1]
		);
	}
	const [spawnX, , spawnZ] = tileToWorld(layout, layout.spawn);
	points.push([spawnX, spawnZ]);
	return { margin: ISO_MARGIN, points };
}

/** What steps out of a conversation shot: cottages and trees. */
interface FocusClearing {
	houses: ReadonlySet<string>;
	trees: ReadonlySet<number>;
}

const NO_CLEARING: FocusClearing = { houses: NO_GHOSTS, trees: new Set() };

/**
 * Cottages that would still stand between the conversation camera and
 * either face (drawn see-through), and trees in the shot (they step out)
 * while the pair is framed.
 */
export function useFocusClearing(
	focus: CameraFocus | null,
	boxes: ReturnType<typeof houseBoxes>,
	trees: readonly TreeObstacle[],
	mode: World3dParams["camera"],
	viewShift: ViewShift
): FocusClearing {
	const size = useThree((state) => state.size);
	const fov = useThree((state) =>
		"fov" in state.camera ? (state.camera.fov as number) : 40
	);
	// Stable keys, so the scenery only rebuilds when a set changes.
	const keys = useMemo(() => {
		if (!focus || mode !== "orbit") {
			return { houses: "", trees: "" };
		}
		const visible = uncoveredSize(size.width, size.height, viewShift);
		const distance = focusDistance(focus, fov, visible.width, visible.height);
		const center = pairCenter(focus.agent, focus.player);
		const eye = focusEye(center, focus.side, distance);
		return {
			houses: [...occludingHouses(focus.agent, focus.player, eye, boxes)]
				.sort()
				.join("\n"),
			trees: [...treesInShot(center, eye, trees)].join(","),
		};
	}, [boxes, focus, fov, mode, size, trees, viewShift]);
	return useMemo(() => {
		if (!(keys.houses || keys.trees)) {
			return NO_CLEARING;
		}
		return {
			houses: keys.houses ? new Set(keys.houses.split("\n")) : NO_GHOSTS,
			trees: new Set(
				keys.trees ? keys.trees.split(",").map((index) => Number(index)) : []
			),
		};
	}, [keys]);
}

/** An agent's plate with acts: where its villager is, its bubble, its press. */
export function actedPlate(
	acts: WorldActView | null,
	agentId: string,
	at: ReadonlyMap<string, Vec3>,
	talkOrAsk: (agentId: string) => void
): { activate?: () => void; at: Vec3; bubble: LifeBubble | null } | null {
	const act = acts?.acts.get(agentId);
	const position = at.get(agentId);
	if (!(acts && act && position)) {
		return null;
	}
	const bubbleId = bubbleOverlayId(act);
	return {
		activate:
			act.act === "asking" && act.ask ? () => talkOrAsk(agentId) : undefined,
		at: position,
		bubble: bubbleId && acts.shown.has(bubbleId) ? actBubble(act) : null,
	};
}
