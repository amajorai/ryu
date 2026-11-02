import type { LifeBubble } from "./game3d-life.ts";
import { type Vec3, VILLAGER_GEAR } from "./game3d-palette.ts";
import {
	fixed,
	type PartSpec,
	type VillagerTool,
} from "./game3d-villager-model.ts";

/** Where the right hand holds a tool, in the rig's local space. */
const HAND: Vec3 = [0.24, 0.21, 0.06];

function atHand(dx: number, dy: number, dz: number): Vec3 {
	return [HAND[0] + dx, HAND[1] + dy, HAND[2] + dz];
}

export const GEAR = VILLAGER_GEAR;

/** One held tool's parts: each rides the right arm's swing. */
function toolParts(
	tool: VillagerTool,
	parts: Omit<PartSpec, "limb" | "when">[]
) {
	return parts.map<PartSpec>((part) => ({
		...part,
		limb: "right",
		when: (looks) => looks.tool === tool,
	}));
}

/**
 * Whether a frame whose villager anchors moved needs one more frame so
 * their plates catch up (drei places a plate before its anchor moves). Only
 * a still, reduced-motion canvas needs it: an animated stage keeps drawing,
 * and a strolling villager's anchor moves every frame, so asking then would
 * keep a paused demand canvas rendering forever.
 */
export function needsAnchorRedraw(
	moved: boolean,
	reducedMotion: boolean
): boolean {
	return moved && reducedMotion;
}

/**
 * Whether the scene needs another frame for its villagers: while any life
 * script still plays its one-off steps (a demand canvas would otherwise
 * stop a villager mid-walk), one more once they finish so the plates catch
 * up, and `needsAnchorRedraw`. A strolling (`walk`) villager is never busy,
 * so a paused demand canvas still goes idle.
 */
export function needsLifeFrame({
	busy,
	moved,
	reducedMotion,
	wasBusy,
}: {
	busy: number;
	moved: boolean;
	reducedMotion: boolean;
	wasBusy: boolean;
}): boolean {
	return busy > 0 || wasBusy || needsAnchorRedraw(moved, reducedMotion);
}

/** A monotonic clock over R3F's, which restarts at 0 on a frame-loop change. */
export interface LifeClock {
	/** The last time read (s). */
	last: number;
	/** Added to R3F's elapsed time (s): the time lost to its restarts. */
	offset: number;
}

/**
 * The life time (s) for R3F's `elapsed`: never earlier than the last read,
 * so a clock restart carries on from where it was instead of rewinding.
 * Reading the same elapsed time twice gives the same time.
 */
export function lifeClockAt(clock: LifeClock, elapsed: number): number {
	let time = elapsed + clock.offset;
	if (time < clock.last) {
		clock.offset += clock.last - time;
		time = clock.last;
	}
	clock.last = time;
	return time;
}

/** A work bubble ("Editing snapshot.ts"): plain-toned, not an ask, problem, limit or result. */
export function isWorkBubble(bubble: LifeBubble): boolean {
	return bubble.tone === undefined || bubble.tone === "plain";
}

/** The parts drawn for a villager holding `tool` (for tests and docs). */
export function toolPartsFor(tool: VillagerTool): readonly PartSpec[] {
	return TOOL_PARTS.filter((part) => part.when?.({ tool } as never));
}

/** Every tool a villager can hold, drawn only for the villagers holding it. */
export const TOOL_PARTS: PartSpec[] = [
	...toolParts("hoe", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.06),
			rotation: [0.3, 0, 0],
			scale: [0.016, 0.62, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, -0.2, 0.16),
			rotation: [0.3, 0, 0],
			scale: [0.12, 0.035, 0.1],
		},
	]),
	...toolParts("can", [
		{
			color: fixed(GEAR.tin),
			geometry: "disc",
			position: atHand(0.03, -0.07, 0.06),
			scale: [0.075, 0.13, 0.075],
			shadow: true,
		},
		{
			color: fixed(GEAR.tin),
			geometry: "stick",
			position: atHand(0.03, -0.04, 0.17),
			rotation: [1.0, 0, 0],
			scale: [0.012, 0.16, 0.012],
		},
		{
			color: fixed(GEAR.tin),
			geometry: "ring",
			position: atHand(0.03, 0.01, 0.04),
			rotation: [0, Math.PI / 2, 0],
			scale: [0.045, 0.045, 0.045],
		},
	]),
	...toolParts("basket", [
		{
			color: fixed(GEAR.wicker),
			geometry: "disc",
			position: atHand(0.02, -0.08, 0.08),
			scale: [0.11, 0.08, 0.1],
			shadow: true,
		},
		...[-1, 0, 1].map((index) => ({
			color: fixed(GEAR.produce[index + 1] ?? GEAR.produce[0]),
			geometry: "ball" as const,
			position: atHand(0.02 + index * 0.05, -0.02, 0.08 + (index % 2) * 0.03),
			scale: [0.04, 0.04, 0.04] as Vec3,
		})),
	]),
	...toolParts("pan", [
		{
			color: fixed(GEAR.pan),
			geometry: "disc",
			position: atHand(0, 0.02, 0.24),
			scale: [0.12, 0.025, 0.12],
			shadow: true,
		},
		{
			color: fixed(GEAR.pan),
			geometry: "stick",
			position: atHand(0, 0.02, 0.06),
			rotation: [Math.PI / 2, 0, 0],
			scale: [0.014, 0.16, 0.014],
		},
	]),
	...toolParts("ladle", [
		{
			color: fixed(GEAR.metal),
			geometry: "stick",
			position: atHand(0, 0.1, 0.05),
			scale: [0.012, 0.32, 0.012],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "dome",
			position: atHand(0, -0.06, 0.05),
			rotation: [Math.PI, 0, 0],
			scale: [0.06, 0.05, 0.06],
		},
	]),
	...toolParts("knife", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(0, 0, 0.04),
			scale: [0.03, 0.08, 0.03],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.12, 0.04),
			scale: [0.012, 0.17, 0.045],
		},
	]),
	...toolParts("hammer", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.04),
			scale: [0.016, 0.3, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.23, 0.04),
			scale: [0.12, 0.05, 0.05],
		},
	]),
	...toolParts("book", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.17, 0.21, 0.025],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.045, 0.137),
			rotation: [-0.5, 0, 0],
			scale: [0.14, 0.17, 0.01],
		},
	]),
	// An account book held open-ish: a dark cover, cream pages, a metal clasp.
	...toolParts("ledger", [
		{
			color: fixed(GEAR.pan),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.18, 0.24, 0.035],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.045, 0.141),
			rotation: [-0.5, 0, 0],
			scale: [0.15, 0.2, 0.012],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0.05, 0.04, 0.125),
			rotation: [-0.5, 0, 0],
			scale: [0.02, 0.07, 0.04],
		},
	]),
	// A hand balance: a post, a beam, a pan hanging at each end.
	...toolParts("scale", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.1, 0.05),
			scale: [0.014, 0.26, 0.014],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.23, 0.05),
			scale: [0.26, 0.016, 0.016],
		},
		...[-1, 1].map((side) => ({
			color: fixed(GEAR.tin),
			geometry: "disc" as const,
			position: atHand(side * 0.12, 0.15, 0.05),
			scale: [0.06, 0.015, 0.06] as Vec3,
		})),
	]),
	...toolParts("broom", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.06),
			rotation: [0.2, 0, 0],
			scale: [0.014, 0.72, 0.014],
		},
		{
			color: fixed(GEAR.bristle),
			geometry: "cone",
			position: atHand(0, -0.3, -0.02),
			rotation: [0.2, 0, 0],
			scale: [0.08, 0.18, 0.08],
		},
	]),
	...toolParts("quill", [
		{
			color: fixed(GEAR.paper),
			geometry: "point",
			position: atHand(0, 0.14, 0.05),
			rotation: [0.25, 0, -0.2],
			scale: [0.045, 0.16, 0.012],
		},
		{
			color: fixed(GEAR.pan),
			geometry: "stick",
			position: atHand(0, -0.02, 0.03),
			rotation: [0.25, 0, -0.2],
			scale: [0.008, 0.07, 0.008],
		},
	]),
	...toolParts("lens", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.02, 0.06),
			scale: [0.014, 0.12, 0.014],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "ring",
			position: atHand(0, 0.15, 0.06),
			scale: [0.07, 0.07, 0.07],
		},
		{
			color: fixed(GEAR.tin),
			geometry: "disc",
			position: atHand(0, 0.15, 0.06),
			rotation: [Math.PI / 2, 0, 0],
			scale: [0.06, 0.006, 0.06],
		},
	]),
	...toolParts("clipboard", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.16, 0.22, 0.015],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.03, 0.13),
			rotation: [-0.5, 0, 0],
			scale: [0.13, 0.16, 0.008],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(-0.04, 0.14, 0.085),
			rotation: [-0.5, 0, 0],
			scale: [0.06, 0.025, 0.02],
		},
	]),
	...toolParts("wrench", [
		{
			color: fixed(GEAR.metal),
			geometry: "stick",
			position: atHand(0, 0.07, 0.05),
			scale: [0.016, 0.24, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "ring",
			position: atHand(0, 0.2, 0.05),
			scale: [0.05, 0.05, 0.05],
		},
	]),
	...toolParts("globe", [
		{
			color: fixed(GEAR.tin),
			geometry: "ball",
			position: atHand(0, 0.08, 0.12),
			scale: [0.1, 0.1, 0.1],
			shadow: true,
		},
		{
			color: fixed(GEAR.produce[2] ?? GEAR.wood),
			geometry: "dome",
			position: atHand(0.02, 0.12, 0.17),
			rotation: [0.8, 0.4, 0],
			scale: [0.05, 0.03, 0.05],
		},
		{
			color: fixed(GEAR.wood),
			geometry: "disc",
			position: atHand(0, -0.04, 0.12),
			scale: [0.06, 0.02, 0.06],
		},
	]),
];
