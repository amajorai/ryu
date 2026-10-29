import type { InterfaceHelpers } from "@ryuhq/protocol/interfaces";
import { CurvedAnchor, type FollowBody } from "./game3d-anchor.tsx";
import {
	ambientLife,
	LIFE_FACE_CAMERA,
	type LifeScript,
} from "./game3d-life.ts";
import { MeterText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";

/**
 * Helpers (spawned session threads) at their parent's station: up to 3
 * small villagers (0.6 scale, no plate) working beside the agent, then a
 * "+N" plate. A failed helper sits slumped with a small ×. Games merge
 * `apprenticeSpecs` into their one `Villagers` cast (same rig, same
 * reduced-motion rules) and draw `ApprenticeTally` for the words.
 */

export const MAX_APPRENTICES = 3;
export const APPRENTICE_SCALE = 0.6;
/** Where apprentices stand around the station, in world units. */
const SPOTS: Vec3[] = [
	[-0.7, 0, 0.45],
	[0.7, 0, 0.45],
	[0, 0, 0.85],
];

/** How many helpers are drawn (running first, then one failed), and the rest. */
export function apprenticeCounts(helpers: InterfaceHelpers | null): {
	failed: number;
	more: number;
	running: number;
} {
	if (!helpers) {
		return { failed: 0, more: 0, running: 0 };
	}
	const running = Math.min(helpers.running, MAX_APPRENTICES);
	const failed = Math.min(helpers.failed, MAX_APPRENTICES - running);
	return {
		failed,
		more: helpers.running + helpers.failed - running - failed,
		running,
	};
}

/** A working helper's script: the kit's ambient loop, resting at work. */
export function apprenticeLife(
	working: boolean,
	key: string,
	seed: string
): LifeScript {
	return {
		idle: working
			? ambientLife(seed, { rest: "work" })
			: [{ do: "wait", seconds: 5 }],
		key,
		steps: [
			{ do: "face", toward: LIFE_FACE_CAMERA },
			{ action: working ? "work" : "slump", do: "pose" },
		],
	};
}

/** The apprentice villagers for one station (merge into the game's cast). */
export function apprenticeSpecs({
	agentId,
	dress,
	follow,
	helpers,
	looks,
	station,
}: {
	agentId: string;
	/**
	 * The game's look for its helpers, over the agent's (elves: a beanie and
	 * the game's green). Default: the agent's looks with no accessory.
	 */
	dress?: Partial<MemberLooks>;
	/**
	 * The agent's walking body: the helpers stay around it as it moves
	 * (`VillagerSpec.follow`), and `station`'s x and z are then ignored.
	 */
	follow?: FollowBody;
	helpers: InterfaceHelpers | null;
	looks: MemberLooks;
	station: Vec3;
}): VillagerSpec[] {
	const { failed, running } = apprenticeCounts(helpers);
	const specs: VillagerSpec[] = [];
	for (let index = 0; index < running + failed; index++) {
		const spot = SPOTS[index] ?? SPOTS[0] ?? [0, 0, 0];
		const working = index < running;
		const [x, z] = follow ? [0, 0] : [station[0], station[2]];
		specs.push({
			follow,
			id: `${agentId}:helper:${index}`,
			label: working ? "Helper, working" : "Helper, failed",
			life: apprenticeLife(
				working,
				working ? "work" : "failed",
				`${agentId}:helper:${index}`
			),
			looks: {
				...looks,
				accessory: "none",
				tool: working ? looks.tool : undefined,
				...dress,
			},
			name: "",
			plate: false,
			pose: working ? "working" : "failed",
			position: [x + spot[0], station[1] + spot[1], z + spot[2]],
			scale: APPRENTICE_SCALE,
		});
	}
	return specs;
}

/** "+N" for helpers beyond the drawn ones, and a × over a failed helper. */
export function ApprenticeTally({
	curved = false,
	follow,
	helpers,
	showText = true,
	station,
}: {
	/** The words sit on a curved stage's ground (CurvedAnchor). */
	curved?: boolean;
	/**
	 * The agent's walking body: the words stay over its helpers (implies
	 * curved; `station`'s x and z are then ignored).
	 */
	follow?: FollowBody;
	helpers: InterfaceHelpers | null;
	showText?: boolean;
	station: Vec3;
}) {
	const { failed, more, running } = apprenticeCounts(helpers);
	if (!showText) {
		return null;
	}
	const failedSpot = SPOTS[running];
	const words = (
		<>
			{failed > 0 && failedSpot ? (
				<MeterText at={[failedSpot[0], 1.05, failedSpot[2]]}>×</MeterText>
			) : null}
			{more > 0 ? <MeterText at={[0, 0.9, 1.1]}>{`+${more}`}</MeterText> : null}
		</>
	);
	// The words sit relative to the station (or the followed body).
	return curved || follow ? (
		<CurvedAnchor follow={follow} position={station}>
			{words}
		</CurvedAnchor>
	) : (
		<group position={station}>{words}</group>
	);
}
