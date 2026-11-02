/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { translate } from "@ryu/i18n/lite";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { Vector3 } from "three";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import type { LifeBubble } from "./game3d-life.ts";
import { bubbleWords, LifeBubbleTag } from "./game3d-life.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import type { VillagerSpec } from "./game3d-villager-looks.ts";
import type { VillagerPose } from "./game3d-villager-model.ts";
import type { RigPose } from "./game3d-villager-rig.tsx";
import { isWorkBubble } from "./game3d-villager-tools.ts";

/** Facing the isometric camera (which looks from +x, +z). */
export const FACE_CAMERA = Math.PI / 4;
/** Name plates float this high over the feet, in world units. */
export const PLATE_HEIGHT = 1.62;
/** A villager's head top above its feet (world units, at scale 1). */
const FIGURE_HEIGHT = 1.35;

/**
 * Two zero-size, hidden markers at a villager's head and feet
 * (`data-act-figure`, `data-figure-edge`), riding its plate anchor: where
 * the figure is on screen, for checks that nothing covers it.
 */
export function FigureProbes({ id, scale }: { id: string; scale: number }) {
	const marker = (edge: "feet" | "head") => (
		<span
			aria-hidden="true"
			className="pointer-events-none block size-0"
			data-act-figure={id}
			data-figure-edge={edge}
		/>
	);
	return (
		<>
			<Html position={[0, (FIGURE_HEIGHT - PLATE_HEIGHT) * scale, 0]}>
				{marker("head")}
			</Html>
			<Html position={[0, -PLATE_HEIGHT * scale, 0]}>{marker("feet")}</Html>
		</>
	);
}
const WALK_SPEED = 0.85;
const IDLE_BOB = 2.6;

/** How far along a looped path `distance` is, and which way it heads. */
function alongPath(
	path: readonly Vec3[],
	distance: number,
	out: Vector3
): number {
	let total = 0;
	for (let index = 0; index < path.length; index++) {
		const from = path[index] as Vec3;
		const to = path[(index + 1) % path.length] as Vec3;
		total += Math.hypot(to[0] - from[0], to[2] - from[2]);
	}
	let left = total > 0 ? distance % total : 0;
	for (let index = 0; index < path.length; index++) {
		const from = path[index] as Vec3;
		const to = path[(index + 1) % path.length] as Vec3;
		const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
		if (left <= length || index === path.length - 1) {
			const t = length > 0 ? left / length : 0;
			out.set(
				from[0] + (to[0] - from[0]) * t,
				from[1] + (to[1] - from[1]) * t,
				from[2] + (to[2] - from[2]) * t
			);
			return Math.atan2(to[0] - from[0], to[2] - from[2]);
		}
		left -= length;
	}
	out.set(...(path[0] ?? [0, 0, 0]));
	return FACE_CAMERA;
}

/** Writes one villager's pose for its state at `time`. */
export function poseVillager(
	spec: VillagerSpec,
	index: number,
	out: RigPose,
	time: number,
	still: boolean
) {
	const phase = index * 1.7;
	let yaw = spec.facing ?? FACE_CAMERA;
	out.position.set(...spec.position);
	if (spec.walk && spec.walk.length > 1) {
		const distance = still ? 0 : time * WALK_SPEED + phase * 3;
		yaw = alongPath(spec.walk, distance, out.position);
		if (!still) {
			// A hop per step, arms swinging opposite.
			out.position.y += Math.abs(Math.sin(time * 7 + phase)) * 0.05;
			out.armLeft = Math.sin(time * 7 + phase) * 0.5;
			out.armRight = -out.armLeft;
		}
		out.rotation.set(0, yaw, 0);
		return;
	}
	if (still) {
		out.rotation.set(spec.pose === "failed" ? 0.22 : 0, yaw, 0);
		if (spec.pose === "failed") {
			out.scale.set(1.04, 0.9, 1.04);
		}
		if (spec.pose === "needs-you") {
			out.armRight = -2.5;
		}
		return;
	}
	let speed = IDLE_BOB;
	let lift = 0.045;
	let sway = Math.sin(time * 1.3 + phase) * 0.04;
	let lean = 0;
	switch (spec.pose) {
		case "working":
			speed = IDLE_BOB * 1.6;
			// A steady chop or stir with the tool hand.
			out.armRight = -0.35 + Math.sin(time * 6 + phase) * 0.55;
			out.armLeft = Math.sin(time * 3 + phase) * 0.12;
			break;
		case "needs-you": {
			// Hops on the spot, waving.
			const hop = Math.max(0, Math.sin(time * 5 + phase));
			lift = 0.16 * hop * hop;
			out.armRight = -2.5 + Math.sin(time * 10 + phase) * 0.35;
			break;
		}
		case "failed":
			// Slumped and still, head hung.
			speed = 0.9;
			lift = 0.01;
			sway = 0;
			lean = 0.22;
			out.scale.set(1.04, 0.9, 1.04);
			break;
		case "waiting":
			speed = IDLE_BOB * 0.6;
			yaw += Math.sin(time * 0.7 + phase) * 0.6;
			break;
		default:
			break;
	}
	const wave = Math.sin(time * speed + phase);
	out.position.y += Math.max(0, wave) * lift;
	out.rotation.set(lean, yaw, sway);
	const stretch = 1 + wave * 0.035;
	const squash = 1 / Math.sqrt(stretch);
	out.scale.set(
		out.scale.x * squash,
		out.scale.y * stretch,
		out.scale.z * squash
	);
}

const POSE_BADGE: Record<
	VillagerPose,
	{ className: string; mark: string } | null
> = {
	failed: { className: "bg-(--gk-bad) text-white", mark: "×" },
	idle: null,
	"needs-you": {
		className: "bg-(--gk-gold) text-(--gk-edge) motion-safe:animate-pulse",
		mark: "!",
	},
	waiting: { className: "bg-(--gk-plate) text-(--gk-ink-muted)", mark: "…" },
	working: { className: "bg-(--gk-info) text-white", mark: "•••" },
};

/** The plate's accessible name: a scripted villager's label already says it all. */
export function villagerPlateLabel(
	spec: Pick<VillagerSpec, "label" | "life">,
	bubble: LifeBubble | null | undefined,
	tl: LiteralMessage = translate
): string {
	const words = bubble ? bubbleWords(bubble) : "";
	return words && !spec.life
		? tl("{label}, says {words}", { label: spec.label, words })
		: spec.label;
}

/** The first character of a name (whole, even an emoji). */
export function initialOf(name: string): string {
	return Array.from(name)[0] ?? "";
}

/**
 * A villager's name plate: the kit's HUD plate, billboarded over its head,
 * and the villager's control (click, Enter, focus ring). A badge sits on
 * the plate's top edge, always in the same place: a pulsing "!" when it
 * needs you, a red mark when it failed, dots while it works.
 *
 * With `spec.activate` it calls that and leaves the selection alone (no
 * `aria-pressed`); otherwise it selects through `onSelect`. `iconOnly` (narrow stages) shows the initial in a 28px
 * target and keeps the full accessible name.
 */
export function VillagerPlate({
	bubble,
	iconOnly = false,
	onSelect,
	selected,
	spec,
}: {
	bubble?: LifeBubble | null;
	iconOnly?: boolean;
	onSelect?: (id: string) => void;
	selected: boolean;
	spec: VillagerSpec;
}) {
	const tl = useLiteralMessages();
	const badge = POSE_BADGE[spec.pose];
	const { activate } = spec;
	const actionable = Boolean(activate ?? onSelect);
	// A game's "work bubbles off" setting hides plain work bubbles; asks,
	// problems, limits and results still show (the plate's name keeps them all).
	const { workBubbles } = useGameKitSettings();
	const shownBubble =
		bubble && (workBubbles || !isWorkBubble(bubble)) ? bubble : null;
	return (
		<Html center zIndexRange={[40, 0]}>
			<button
				aria-label={villagerPlateLabel(spec, bubble, tl)}
				aria-pressed={!activate && onSelect ? selected : undefined}
				className={cn(
					GAME_PLATE,
					GAME_FOCUS,
					"gk-display relative flex h-7 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full text-[13px] leading-none",
					iconOnly ? "min-w-7" : "px-2.5",
					selected && !activate && "bg-(--gk-accent) text-(--gk-accent-ink)"
				)}
				data-act-agent={spec.actAgent}
				data-icon-only={iconOnly ? "" : undefined}
				data-iso-focus={spec.id}
				data-iso-target=""
				data-you-spot={spec.youSpot}
				onClick={() => (activate ? activate() : onSelect?.(spec.id))}
				tabIndex={actionable ? 0 : -1}
				type="button"
			>
				{badge ? (
					<span
						aria-hidden="true"
						className={cn(
							"absolute -top-5 left-1/2 grid h-6 min-w-6 -translate-x-1/2 place-items-center rounded-full border-(--gk-edge) border-2 px-1 font-bold text-[13px] leading-none",
							badge.className
						)}
					>
						{badge.mark}
					</span>
				) : null}
				{shownBubble ? (
					<LifeBubbleTag bubble={shownBubble} side={spec.bubbleSide} />
				) : null}
				<span className={iconOnly ? undefined : "max-w-28 truncate"}>
					{iconOnly ? initialOf(spec.name) : spec.name}
				</span>
			</button>
		</Html>
	);
}
