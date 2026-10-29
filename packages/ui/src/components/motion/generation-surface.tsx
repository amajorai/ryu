"use client";

// The shared body of the generated-media surfaces in this directory:
// `./image-generation.tsx` (vendored from beui.dev/components/agents/
// image-generation) and its video sibling `./video-generation.tsx`.
//
// A stable generated-media surface: the frame is reserved up front, so a turn
// moves from "generating" through to finished media without any layout shift.
// While work is in flight a dithered dot field fills the frame; when the media
// lands it fades in over the field and the field unmounts.
//
// The public surfaces keep their own props, status names and copy, corner
// badge, and frame style (aspect ratio, plus the poster still for video); every
// part they render identically lives here. The imports point at this repo's own
// motion primitives — `@ryu/ui/lib/ease` for the shared curves and
// `@ryu/ui/hooks/use-hover-capable` for the touch-device hover gate — exactly
// like its neighbours in this directory.

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { EASE_OUT, SPRING_PRESS } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Check, CircleAlert, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * The lifecycle both surfaces share. `detailing` is the partial-preview phase
 * that each surface names for itself: images are `refining`, videos `rendering`.
 */
export type GenerationPhase =
	| "queued"
	| "generating"
	| "detailing"
	| "complete"
	| "error";

/** Props both public surfaces accept with the same meaning. */
export interface GenerationMediaProps {
	/** CSS aspect ratio reserved before generated media is available. */
	aspectRatio?: CSSProperties["aspectRatio"];
	className?: string;
	/** Lets the active dither cluster follow fine-pointer movement. */
	interactive?: boolean;
	/** Accessible description. Defaults to a description derived from prompt. */
	label?: string;
	mediaClassName?: string;
	onRetry?: () => void;
	prompt?: string;
	showStatus?: boolean;
	size?: "compact" | "fluid";
	statusClassName?: string;
	statusText?: string;
}

type GenerationKind = "image" | "video";

interface GenerationSurfaceProps
	extends Omit<GenerationMediaProps, "aspectRatio" | "statusText"> {
	/** Corner badge text. Omitted ⇒ no badge. */
	badge?: string;
	children?: ReactNode;
	/** The caller's CSS-module class that reserves the frame. */
	frameClassName: string;
	kind: GenerationKind;
	phase: GenerationPhase;
	/** The caller's own status name, mirrored to `data-state`. */
	state: string;
	/** The resolved status line (the caller's override or its default copy). */
	statusText: string;
	/** The frame's CSS custom properties, read by `frameClassName`. */
	style: CSSProperties;
}

const KIND_FRAME = {
	image: {
		mediaClassName:
			"absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_img]:size-full [&_img]:object-cover",
		slot: "image-generation",
	},
	video: {
		mediaClassName:
			"absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_video]:size-full [&_video]:object-cover",
		slot: "video-generation",
	},
} satisfies Record<GenerationKind, { mediaClassName: string; slot: string }>;

const MEDIA_STATE = {
	queued: { filter: "blur(4px) saturate(0.75)", opacity: 0, scale: 1.02 },
	generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
	detailing: {
		filter: "blur(1.5px) saturate(0.95)",
		opacity: 0.62,
		scale: 1.005,
	},
	complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
	error: { filter: "blur(2px) saturate(0.5)", opacity: 0.28, scale: 1 },
} satisfies Record<
	GenerationPhase,
	{ filter: string; opacity: number; scale: number }
>;

const OVERLAY_OPACITY = {
	queued: 1,
	generating: 1,
	detailing: 0.48,
	complete: 0,
	error: 0,
} satisfies Record<GenerationPhase, number>;

const DOT_GAP = 10;
const TWO_PI = Math.PI * 2;
const FALLBACK_FIELD_SIZE = 208;
const MAX_DPR = 2;

/** Pointer the dither cluster gravitates toward — real cursor, or a drift. */
interface DitherPointer {
	inside: boolean;
	targetX: number;
	targetY: number;
	x: number;
	y: number;
}

/**
 * Paint one frame of the dot field. Each dot is displaced away from the
 * pointer by a smoothstep falloff, so the cluster reads as a soft lens moving
 * over an ordered grid.
 */
function paintDitherField(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
	pointer: DitherPointer
) {
	const radius = Math.min(width, height) * 0.38;
	const columns = Math.ceil(width / DOT_GAP) + 1;
	const rows = Math.ceil(height / DOT_GAP) + 1;
	const offsetX = (width - (columns - 1) * DOT_GAP) / 2;
	const offsetY = (height - (rows - 1) * DOT_GAP) / 2;

	for (let row = 0; row < rows; row += 1) {
		for (let column = 0; column < columns; column += 1) {
			const anchorX = offsetX + column * DOT_GAP;
			const anchorY = offsetY + row * DOT_GAP;
			const deltaX = anchorX - pointer.x;
			const deltaY = anchorY - pointer.y;
			const distance = Math.hypot(deltaX, deltaY);
			const proximity = Math.max(0, 1 - distance / radius);
			const influence = proximity * proximity * (3 - 2 * proximity);
			const displacement = influence * influence * 9;
			const directionX = distance > 0 ? deltaX / distance : 0;
			const directionY = distance > 0 ? deltaY / distance : 0;
			const x = anchorX + directionX * displacement;
			const y = anchorY + directionY * displacement;
			const dotRadius = 0.65 + influence * 0.85;

			context.globalAlpha = 0.17 + influence * 0.72;
			context.beginPath();
			context.arc(x, y, dotRadius, 0, TWO_PI);
			context.fill();
		}
	}

	context.globalAlpha = 1;
}

function DitherMark({
	phase,
	reduce,
}: {
	phase: GenerationPhase;
	reduce: boolean;
}) {
	if (phase === "complete") {
		return <Check aria-hidden="true" className="size-3.5" />;
	}

	if (phase === "error") {
		return <CircleAlert aria-hidden="true" className="size-3.5" />;
	}

	return (
		<motion.span
			animate={reduce ? undefined : { rotate: 360 }}
			aria-hidden="true"
			className="grid size-3.5 grid-cols-2 place-items-center gap-0.5"
			transition={{
				duration: 2.4,
				ease: "linear",
				repeat: Number.POSITIVE_INFINITY,
			}}
		>
			<span className="size-1 rounded-[1px] bg-current" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current" />
		</motion.span>
	);
}

function DitherField({
	interactive,
	phase,
	reduce,
}: {
	interactive: boolean;
	phase: GenerationPhase;
	reduce: boolean;
}) {
	const canHover = useHoverCapable();
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!(canvas && context)) {
			return;
		}

		let frame = 0;
		let width = 0;
		let height = 0;
		let dotColor = "currentColor";
		const pointer: DitherPointer = {
			x: 0,
			y: 0,
			targetX: 0,
			targetY: 0,
			inside: false,
		};
		const pointerEnabled = interactive && canHover && !reduce;

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			width = rect.width || canvas.clientWidth || FALLBACK_FIELD_SIZE;
			height = rect.height || canvas.clientHeight || FALLBACK_FIELD_SIZE;
			const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
			dotColor = window.getComputedStyle(canvas).color;
			pointer.x = width / 2;
			pointer.y = height / 2;
			pointer.targetX = pointer.x;
			pointer.targetY = pointer.y;
		};

		const draw = (time: number) => {
			context.clearRect(0, 0, width, height);

			if (!pointer.inside) {
				pointer.targetX =
					width / 2 + (reduce ? 0 : Math.sin(time / 1700) * width * 0.12);
				pointer.targetY =
					height / 2 + (reduce ? 0 : Math.cos(time / 2100) * height * 0.1);
			}

			let follow = 0.045;
			if (reduce) {
				follow = 1;
			} else if (pointer.inside) {
				follow = 0.16;
			}
			pointer.x += (pointer.targetX - pointer.x) * follow;
			pointer.y += (pointer.targetY - pointer.y) * follow;

			context.fillStyle = dotColor;
			paintDitherField(context, width, height, pointer);

			if (!reduce) {
				frame = window.requestAnimationFrame(draw);
			}
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (!pointerEnabled) {
				return;
			}
			const rect = canvas.getBoundingClientRect();
			pointer.inside = true;
			pointer.targetX = event.clientX - rect.left;
			pointer.targetY = event.clientY - rect.top;
		};

		const handlePointerLeave = () => {
			pointer.inside = false;
		};

		const resizeObserver =
			globalThis.ResizeObserver === undefined
				? null
				: new ResizeObserver(resize);

		resize();
		resizeObserver?.observe(canvas);
		canvas.addEventListener("pointermove", handlePointerMove, {
			passive: true,
		});
		canvas.addEventListener("pointerleave", handlePointerLeave);
		draw(0);

		return () => {
			if (frame) {
				window.cancelAnimationFrame(frame);
			}
			resizeObserver?.disconnect();
			canvas.removeEventListener("pointermove", handlePointerMove);
			canvas.removeEventListener("pointerleave", handlePointerLeave);
		};
	}, [canHover, interactive, reduce]);

	return (
		<motion.div
			animate={{ opacity: OVERLAY_OPACITY[phase] }}
			aria-hidden="true"
			className="absolute inset-0 overflow-hidden bg-muted"
			initial={false}
			transition={{ duration: reduce ? 0 : 0.4, ease: EASE_OUT }}
		>
			<canvas
				className="absolute inset-0 size-full text-foreground"
				ref={canvasRef}
			/>
		</motion.div>
	);
}

export function GenerationSurface({
	badge,
	children,
	className,
	frameClassName,
	interactive = true,
	kind,
	label,
	mediaClassName,
	onRetry,
	phase,
	prompt,
	showStatus = true,
	size = "compact",
	state,
	statusClassName,
	statusText,
	style,
}: GenerationSurfaceProps) {
	const reduce = useReducedMotion() ?? false;
	const active =
		phase === "queued" || phase === "generating" || phase === "detailing";
	const mediaState = MEDIA_STATE[phase];
	const resolvedLabel =
		label ?? (prompt ? `${statusText}: ${prompt}` : statusText);

	return (
		<div
			aria-busy={active}
			className={cn("w-full", className)}
			data-slot={KIND_FRAME[kind].slot}
			data-state={state}
		>
			<div className={cn("w-full", size === "compact" && "mx-auto max-w-52")}>
				{/* Only the image frame carries `role="img"`. A video's playable
				    element is the accessible object and its own label names it,
				    so once it lands the frame keeps only the reserved box and the
				    poster still. */}
				<div
					aria-label={kind === "video" && children ? undefined : resolvedLabel}
					className={[
						frameClassName,
						"relative isolate w-full overflow-hidden rounded-xl bg-muted",
					].join(" ")}
					role={kind === "image" ? "img" : undefined}
					style={style}
				>
					<motion.div
						animate={
							reduce
								? { opacity: mediaState.opacity }
								: {
										filter: mediaState.filter,
										opacity: mediaState.opacity,
										scale: mediaState.scale,
									}
						}
						aria-hidden={children ? undefined : true}
						className={cn(KIND_FRAME[kind].mediaClassName, mediaClassName)}
						initial={false}
						transition={
							reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }
						}
					>
						{children}
					</motion.div>

					<AnimatePresence initial={false}>
						{active ? (
							<motion.div
								animate={{ opacity: 1 }}
								className="absolute inset-0"
								exit={{ opacity: 0 }}
								initial={{ opacity: 0 }}
								key="dither-field"
								transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
							>
								<DitherField
									interactive={interactive}
									phase={phase}
									reduce={reduce}
								/>
							</motion.div>
						) : null}
					</AnimatePresence>

					{badge ? (
						<span className="type-compact absolute top-2 right-2 z-10 rounded-full bg-background/75 px-2 py-0.5 font-mono text-muted-foreground tabular-nums">
							{badge}
						</span>
					) : null}
				</div>

				{showStatus || prompt ? (
					<div className="mt-3 text-left">
						{showStatus ? (
							<div
								aria-live="polite"
								className={cn(
									"flex min-h-5 items-center gap-2 font-medium text-foreground text-sm",
									phase === "error" && "text-status-destructive",
									statusClassName
								)}
							>
								<DitherMark phase={phase} reduce={reduce} />
								<AnimatePresence initial={false} mode="popLayout">
									<motion.span
										animate={{ opacity: 1, y: 0 }}
										exit={reduce ? undefined : { opacity: 0, y: -4 }}
										initial={reduce ? false : { opacity: 0, y: 4 }}
										key={statusText}
										transition={{
											duration: reduce ? 0 : 0.15,
											ease: EASE_OUT,
										}}
									>
										{statusText}
									</motion.span>
								</AnimatePresence>
							</div>
						) : null}
						{prompt ? (
							<p className="mt-0.5 truncate text-muted-foreground text-xs">
								"{prompt}"
							</p>
						) : null}
					</div>
				) : null}

				{phase === "error" && onRetry ? (
					<motion.button
						className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full px-3 font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onRetry}
						transition={SPRING_PRESS}
						type="button"
						whileTap={reduce ? undefined : { scale: 0.96 }}
					>
						<RotateCcw aria-hidden="true" className="size-4" />
						Try again
					</motion.button>
				) : null}
			</div>
		</div>
	);
}
