"use client";

import { formatPercent } from "@ryu/i18n/format-percent";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Copy, Gift } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { drawFoil, fitCanvas, foilTextFrom } from "./scratch-card-foil.ts";

// A physical-feeling scratch-off card: the coupon sits under a frosted foil
// painted onto a <canvas> (a blurred rendering of the code plus a veil).
// Rubbing erases the foil (destination-out compositing), so the blur wipes
// away only under the pointer and the sharp code shows through. Once enough
// is rubbed off we auto-clear the rest and lock the coupon in as "revealed".
// Keyboard/AT users get an explicit "Reveal code" button so the reward never
// hides behind a pointer-only gesture.

const REVEAL_THRESHOLD = 0.5; // fraction of foil scratched before auto-reveal
const SAMPLE_STRIDE = 32; // sample every Nth pixel when measuring progress
const BRUSH_RADIUS = 24; // scratch brush radius in CSS pixels
const COPIED_RESET_MS = 2000;
const FOIL_BLUR_PX = 10;
const VEIL_ALPHA = 0.25;
const TRANSPARENT_COLORS = new Set(["", "transparent", "rgba(0, 0, 0, 0)"]);
/** Last-resort opaque base so a transparent theme never lets the code peek. */
const FALLBACK_BASE = "rgb(128, 128, 128)";

/**
 * The discount the card reveals: a 0-100 `discountPercent` formatted in the
 * reader's number format ("30%", "30 %" in French), or a preformatted
 * `discountLabel` that overrides it.
 */
type ScratchCardDiscount =
	| { discountLabel?: string; discountPercent: number }
	| { discountLabel: string; discountPercent?: number };

type ScratchCardProps = ScratchCardDiscount & ScratchCardOptions;

interface ScratchCardOptions {
	ariaLabel?: string;
	brushSize?: number;
	/** Small print under the code, e.g. "Use at checkout — expires soon." */
	caption?: string;
	className?: string;
	code: string;
	/** The teaser line above the card. */
	headline?: string;
	onNeverShowAgain?: () => void;
	onProgress?: (progress: number) => void;
	onReveal?: () => void;
	/** CSS color tinting the frosted blur layer (defaults to a light veil). */
	overlayColor?: string;
	overlayLabel?: string;
	overlayLabelColor?: string;
	revealAnnouncement?: string;
	revealThreshold?: number;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Rub the mask away along the segment from `from` to `to` with a soft-edged
 * brush, so fast drags leave a continuous trail instead of dotted holes.
 */
export const rubMask = (
	ctx: CanvasRenderingContext2D,
	from: Point,
	to: Point,
	radius: number
): void => {
	ctx.globalCompositeOperation = "destination-out";
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	const steps = Math.max(1, Math.ceil(distance / (radius / 3)));
	for (let step = 0; step <= steps; step += 1) {
		const x = from.x + ((to.x - from.x) * step) / steps;
		const y = from.y + ((to.y - from.y) * step) / steps;
		const brush = ctx.createRadialGradient(x, y, 0, x, y, radius);
		brush.addColorStop(0, "rgba(0, 0, 0, 1)");
		brush.addColorStop(0.6, "rgba(0, 0, 0, 1)");
		brush.addColorStop(1, "rgba(0, 0, 0, 0)");
		ctx.fillStyle = brush;
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
	}
};

export default function ScratchCard({
	code,
	discountLabel: discountLabelOverride,
	discountPercent,
	headline = "I have a 30% discount. Just scratch this card!",
	caption,
	className,
	ariaLabel = "Scratch card. Rub the blurred card to reveal the offer.",
	brushSize = 36,
	onProgress,
	onReveal,
	onNeverShowAgain,
	overlayColor,
	overlayLabel,
	overlayLabelColor,
	revealAnnouncement = "Your offer is revealed.",
	revealThreshold = REVEAL_THRESHOLD,
}: ScratchCardProps) {
	const tl = useLiteralMessages();
	const formatLocale = useOptionalI18n()?.formatLocale;
	const discountLabel =
		discountLabelOverride ??
		formatPercent((discountPercent ?? 0) / 100, 0, formatLocale);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const rewardRef = useRef<HTMLDivElement | null>(null);
	const lastPointRef = useRef<Point | null>(null);
	// Once the user has rubbed, stop auto-repainting the foil on resize so we
	// never wipe their progress (the card can mount mid-animation and grow).
	const dirtyRef = useRef(false);
	const revealedRef = useRef(false);
	const onProgressRef = useRef(onProgress);
	const onRevealRef = useRef(onReveal);
	const [revealed, setRevealed] = useState(false);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		onProgressRef.current = onProgress;
		onRevealRef.current = onReveal;
	}, [onProgress, onReveal]);

	const clearFoil = useCallback(() => {
		if (revealedRef.current) {
			return;
		}
		const canvas = canvasRef.current;
		canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		revealedRef.current = true;
		setRevealed(true);
		onRevealRef.current?.();
	}, []);

	const rubLabel = overlayLabel ?? tl("Rub to reveal");
	const rubHint = tl("Rub across the card to wipe the blur away");

	// Paint the frosted foil from the sharp reward's live layout and colours.
	const paintFoil = useCallback(() => {
		const canvas = canvasRef.current;
		const reward = rewardRef.current;
		if (!(canvas && reward)) {
			return;
		}
		const fitted = fitCanvas(canvas);
		if (!fitted) {
			return;
		}
		const canvasRect = canvas.getBoundingClientRect();
		const rewardStyle = getComputedStyle(reward);
		const bodyColor = getComputedStyle(document.body).backgroundColor;
		const base = TRANSPARENT_COLORS.has(bodyColor) ? FALLBACK_BASE : bodyColor;
		const labelColor = overlayLabelColor ?? rewardStyle.color;
		const family = rewardStyle.fontFamily;
		const middle = fitted.height / 2;
		drawFoil(fitted.ctx, {
			background: rewardStyle.backgroundColor,
			base,
			blurPx: FOIL_BLUR_PX,
			height: fitted.height,
			labels: [
				{
					color: labelColor,
					font: `600 14px ${family}`,
					text: rubLabel,
					y: middle - 9,
				},
				{
					color: labelColor,
					font: `400 12px ${family}`,
					text: rubHint,
					y: middle + 10,
				},
			],
			texts: Array.from(
				reward.querySelectorAll<HTMLElement>("[data-foil-text]"),
				(element) => foilTextFrom(element, canvasRect)
			),
			veilAlpha: overlayColor ? 1 : VEIL_ALPHA,
			veilColor: overlayColor ?? base,
			width: fitted.width,
		});
	}, [overlayColor, overlayLabelColor, rubHint, rubLabel]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || revealed) {
			return;
		}
		paintFoil();
		// The card can mount while its container is still animating open (and
		// before web fonts load), so repaint until the user starts rubbing.
		const repaint = () => {
			if (!(dirtyRef.current || revealedRef.current)) {
				paintFoil();
			}
		};
		const observer = new ResizeObserver(repaint);
		observer.observe(canvas);
		document.fonts?.ready.then(repaint).catch(() => undefined);
		return () => observer.disconnect();
	}, [paintFoil, revealed]);

	const measureProgress = useCallback((canvas: HTMLCanvasElement) => {
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return 0;
		}
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		let cleared = 0;
		let total = 0;
		for (let i = 3; i < data.length; i += 4 * SAMPLE_STRIDE) {
			total += 1;
			if (data[i] === 0) {
				cleared += 1;
			}
		}
		return total === 0 ? 0 : cleared / total;
	}, []);

	const scratchAt = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			const canvas = canvasRef.current;
			if (!canvas || revealedRef.current) {
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return;
			}
			dirtyRef.current = true;
			const rect = canvas.getBoundingClientRect();
			const point = {
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
			};
			rubMask(
				ctx,
				lastPointRef.current ?? point,
				point,
				brushSize / 2 || BRUSH_RADIUS
			);
			lastPointRef.current = point;

			const progress = measureProgress(canvas);
			onProgressRef.current?.(progress);
			if (progress >= revealThreshold) {
				clearFoil();
			}
		},
		[brushSize, clearFoil, measureProgress, revealThreshold]
	);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			lastPointRef.current = null;
			event.currentTarget.setPointerCapture(event.pointerId);
			scratchAt(event);
		},
		[scratchAt]
	);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			// Only rub while pressed (hovering mice and pens report no buttons).
			if (event.buttons === 0) {
				lastPointRef.current = null;
				return;
			}
			scratchAt(event);
		},
		[scratchAt]
	);

	const stopScratching = useCallback(() => {
		lastPointRef.current = null;
	}, []);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			setCopied(false);
		}
	}, [code]);

	const reward = (
		<div
			className="@container absolute inset-0 flex min-w-0 flex-col items-center justify-center overflow-hidden rounded-xl border border-border border-dashed bg-muted px-3 text-center"
			ref={rewardRef}
		>
			<span
				className="whitespace-nowrap font-medium text-primary text-sm"
				data-foil-text
			>
				{tl("{discountLabel} off", { discountLabel })}
			</span>
			<motion.span
				animate={
					revealed ? { scale: 1, opacity: 1 } : { scale: 0.95, opacity: 0.85 }
				}
				// Sized to the card's own width so the code never spills past
				// the dashed edge, however narrow the card is rendered.
				className="mt-1 max-w-full whitespace-nowrap ps-[0.1em] font-medium font-mono text-[clamp(1.125rem,12cqi,2.25rem)] text-foreground leading-tight tracking-widest"
				data-foil-text
				transition={{ type: "spring", stiffness: 260, damping: 18 }}
			>
				{code}
			</motion.span>
			<span className="mt-1 text-muted-foreground text-xs" data-foil-text>
				{tl("Coupon code")}
			</span>
		</div>
	);

	return (
		<MotionConfig reducedMotion="user">
			<div
				className={cn(
					"relative mx-auto w-full max-w-sm select-none overflow-hidden rounded-2xl border border-border bg-card p-6",
					className
				)}
			>
				<div className="mb-4 flex items-center justify-center gap-2 text-center text-muted-foreground text-sm">
					<Gift aria-hidden="true" className="size-4 shrink-0 text-primary" />
					<span>{headline}</span>
				</div>

				{/* The sharp reward, under a frosted foil canvas that rubs away. */}
				<div className="relative aspect-[16/9] w-full">
					{reward}

					{/* The foil itself: erased pixels reveal the code beneath. */}
					<canvas
						aria-label={ariaLabel}
						className={cn(
							"absolute inset-0 size-full rounded-xl transition-opacity duration-500",
							revealed
								? "pointer-events-none opacity-0"
								: "cursor-grab touch-none active:cursor-grabbing"
						)}
						data-testid="scratch-card-foil"
						onPointerCancel={stopScratching}
						onPointerDown={handlePointerDown}
						onPointerLeave={stopScratching}
						onPointerMove={handlePointerMove}
						onPointerUp={stopScratching}
						ref={canvasRef}
						role="img"
					>
						{rubLabel}
					</canvas>
				</div>
				<span aria-live="polite" className="sr-only">
					{revealed ? revealAnnouncement : ""}
				</span>
				<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
					{revealed ? (
						<button
							className={cn(buttonVariants({ variant: "mono", size: "sm" }))}
							onClick={handleCopy}
							type="button"
						>
							{copied ? (
								<Check aria-hidden="true" className="size-4" />
							) : (
								<Copy aria-hidden="true" className="size-4" />
							)}
							{copied ? "Copied!" : tl("Copy {code}", { code })}
						</button>
					) : (
						<button
							className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
							onClick={clearFoil}
							type="button"
						>
							Can't scratch? Reveal code
						</button>
					)}
					{onNeverShowAgain ? (
						<button
							className={cn(
								buttonVariants({ variant: "ghost", size: "sm" }),
								"text-muted-foreground hover:text-foreground"
							)}
							onClick={onNeverShowAgain}
							type="button"
						>
							Never show again
						</button>
					) : null}
				</div>

				{caption ? (
					<p className="mt-3 text-center text-muted-foreground/70 text-xs">
						{caption}
					</p>
				) : null}
			</div>
		</MotionConfig>
	);
}
