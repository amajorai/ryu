import { cn } from "@ryu/ui/lib/utils";
import type { WorldEntity } from "@ryuhq/protocol/interfaces";
import { memo, type RefObject } from "react";
import { SV_TEXT } from "./world-2d-frame.ts";
import type { SceneMargin } from "./world-2d-layout.ts";
import { SV_UI } from "./world-2d-palette.ts";
import { CHARACTER, SCALE } from "./world-2d-pixel.ts";
import { actorFeet } from "./world-2d-render.ts";

/**
 * The accessible layer over the canvas: one transparent "Talk to <name>"
 * button over each villager (Stardew's selection corners on hover/focus,
 * and the villager's name above their head on hover/focus, so plates never
 * cover the art; when the player stands close the "E" prompt above the
 * hotbar is the one call to action), and the player's own "You" element,
 * moved by the render loop in step with the canvas.
 */

/** One villager: a talk button over the sprite on its doorstep. */
export const AgentActor = memo(function AgentActor({
	asking = false,
	emote,
	entity,
	indoor,
	margin,
	near,
	onTalk,
	talking,
}: {
	/** Asking the user: pressing it answers (opens the ask). */
	asking?: boolean;
	/** Something floats over the head ("..." or "!"): labels sit above it. */
	emote: boolean;
	entity: WorldEntity;
	indoor: boolean;
	margin: SceneMargin;
	near: boolean;
	onTalk: (agentId: string) => void;
	talking: boolean;
}) {
	const prompt = near && !talking;
	const feet = actorFeet(entity, margin, indoor);
	// Seated villagers show only their upper body over the desk.
	const height = indoor ? 26 : CHARACTER.h;
	return (
		<button
			aria-label={`${asking ? "Answer" : "Talk to"} ${entity.name}`}
			className="group absolute cursor-pointer outline-none"
			onClick={() => onTalk(entity.agentId)}
			style={{
				height: height * SCALE,
				left: (feet.x - CHARACTER.w / 2 - 2) * SCALE,
				top: (feet.y - CHARACTER.h) * SCALE,
				width: (CHARACTER.w + 4) * SCALE,
				zIndex: prompt ? 30 : 10 + entity.y,
			}}
			tabIndex={-1}
			type="button"
		>
			{/* Hover / focus: Stardew's chunky selection corners. */}
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-x-[-3px] top-[6px] bottom-[-3px] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
					talking && "opacity-100"
				)}
			>
				{(
					[
						"top-0 left-0",
						"top-0 right-0 rotate-90",
						"right-0 bottom-0 rotate-180",
						"bottom-0 left-0 -rotate-90",
					] as const
				).map((position) => (
					<svg
						className={cn("absolute", position)}
						height="15"
						key={position}
						shapeRendering="crispEdges"
						viewBox="0 0 5 5"
						width="15"
					>
						<path d="M0 0h5v2h-3v3h-2z" fill={SV_UI.outline} />
						<path d="M1 1h3v0.9h-2.1v2.1h-0.9z" fill={SV_UI.focus} />
					</svg>
				))}
			</span>
			{prompt ? null : (
				<span
					aria-hidden="true"
					className={cn(
						"font-(family-name:--sv-font) pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap border-(--sv-wood-dark) border-2 bg-(--sv-key) px-1 font-normal text-[16px] leading-5 opacity-0 shadow-[0_2px_0_var(--sv-outline)] [font-synthesis:none] group-hover:opacity-100 group-focus-visible:opacity-100",
						emote ? "-top-[64px]" : "-top-[24px]"
					)}
					style={SV_TEXT}
				>
					{entity.name}
				</span>
			)}
		</button>
	);
});

/** The player's accessible element; the render loop sets its transform. */
export function PlayerMarker({
	elementRef,
}: {
	elementRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			aria-label="You"
			className="pointer-events-none absolute top-0 left-0"
			ref={elementRef}
			role="img"
			style={{
				height: CHARACTER.h * SCALE,
				width: CHARACTER.w * SCALE,
				zIndex: 20,
			}}
		/>
	);
}
