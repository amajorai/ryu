import { useMemo } from "react";
import type { LifeBubbleSide, LifeScript } from "./game3d-life.ts";
import {
	type AgentSwatch,
	accentFor,
	agentSwatches,
	swatchOf,
	type Vec3,
	villagerLooks,
} from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerAccessory,
	VillagerPose,
} from "./game3d-villager-model.ts";

/** Accessories agents pick from by default (games may dress them). */
const EVERYDAY_ACCESSORIES: readonly VillagerAccessory[] = [
	"cap",
	"bow",
	"flower",
	"beanie",
	"bandana",
	"none",
];

function idHash(id: string): number {
	let hash = 7;
	for (const character of id) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
	}
	return hash;
}

/** An agent's everyday head accessory, stable per agent. */
export function accessoryFor(agentId: string): VillagerAccessory {
	return (
		EVERYDAY_ACCESSORIES[idHash(agentId) % EVERYDAY_ACCESSORIES.length] ??
		"none"
	);
}

/** One agent's villager looks: outfit from its swatch, hair, accessory. */
export function villagerLooksFor(
	agentId: string,
	swatch: AgentSwatch,
	dress?: Partial<MemberLooks>
): MemberLooks {
	return {
		...villagerLooks(agentId, swatch),
		accent: accentFor(swatch),
		accessory: accessoryFor(agentId),
		...dress,
	};
}

/**
 * Every agent's villager looks, keyed by agent id, with distinct outfit
 * colors (see `agentSwatches`). `dress` lets a game put everyone in its
 * uniform (a chef's hat) or hand out tools.
 */
export function useVillagerLooks(
	agentIds: readonly string[],
	night: boolean,
	dress?: (agentId: string) => Partial<MemberLooks> | undefined
): {
	looks: ReadonlyMap<string, MemberLooks>;
	swatches: ReadonlyMap<string, AgentSwatch>;
} {
	const key = agentIds.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the ids' contents, not the array's identity.
	return useMemo(() => {
		const ids = key ? key.split("\n") : [];
		const swatches = agentSwatches(ids, night);
		const looks = new Map<string, MemberLooks>();
		for (const id of ids) {
			looks.set(id, villagerLooksFor(id, swatchOf(swatches, id), dress?.(id)));
		}
		return { looks, swatches };
	}, [dress, key, night]);
}

/** One villager on stage. */
export interface VillagerSpec {
	/**
	 * The agent this plate is the per-agent target of (`data-act-agent`,
	 * for the act layer's browser checks).
	 */
	actAgent?: string;
	/**
	 * What activating the plate does instead of `onSelect` (an asking
	 * agent's plate opens its ask card). When set the plate is always
	 * focusable, does not touch the game's selection, and has no
	 * `aria-pressed`.
	 */
	activate?: () => void;
	/**
	 * False hides the life script's bubble on the plate (the overlay budget
	 * dropped it) without touching the script.
	 */
	bubble?: boolean;
	/** Where its bubble hangs (default "auto": clear of the neighbours). */
	bubbleSide?: LifeBubbleSide;
	/** Yaw in radians; by default the villager faces the isometric camera. */
	facing?: number;
	/**
	 * A walking body this villager keeps up with (an agent's own body, for its
	 * helpers): every frame the villager's position, plate and life script
	 * are offset by the body's ground x and z, so `position` and the script's
	 * places are relative to it. Default: none (world positions).
	 */
	follow?: () => { x: number; z: number } | undefined;
	/**
	 * Overrides `Villagers iconOnly` for this plate: false keeps a queue
	 * plate's words ("Ada · 14m") on narrow stages.
	 */
	iconOnly?: boolean;
	id: string;
	/** The name plate's accessible name ("Ada, needs you"). */
	label: string;
	/**
	 * A choreography to act out (game3d-life.ts). When set it drives the
	 * villager instead of `pose` and `walk`: a new `key` plays the new
	 * steps from wherever the villager is, then its `idle` loop runs.
	 */
	life?: LifeScript;
	looks: MemberLooks;
	name: string;
	/** False: no name plate (apprentices, background extras). */
	plate?: false;
	pose: VillagerPose;
	/** Where its feet stand (the start of `walk` when it strolls). */
	position: Vec3;
	/** Size against an ordinary villager (1); a game's mascot may stand taller. */
	scale?: number;
	/** A looped path to stroll along, in world points. */
	walk?: readonly Vec3[];
	/** This plate is a you-spot queue plate (`data-you-spot="slot"`). */
	youSpot?: "slot";
}
