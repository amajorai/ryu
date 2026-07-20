"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Copy, Gift, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

// A physical-feeling scratch-off card: a foil layer painted on a <canvas>
// erases under the pointer (destination-out compositing). Once enough of the
// foil is gone we auto-clear the rest and lock the coupon in as "revealed".
// Keyboard/AT users get an explicit "Reveal code" button so the reward never
// hides behind a pointer-only gesture.

const REVEAL_THRESHOLD = 0.5; // fraction of foil scratched before auto-reveal
const SAMPLE_STRIDE = 32; // sample every Nth pixel when measuring progress
const BRUSH_RADIUS = 24; // scratch brush radius in CSS pixels
const COPIED_RESET_MS = 2000;

interface ScratchCardProps {
	/** Small print under the code, e.g. "Use at checkout — expires soon." */
	caption?: string;
	className?: string;
	code: string;
	/** Discount headline, e.g. "30%" (rendered as "30% off"). */
	discountLabel: string;
	/** The teaser line above the card. */
	headline?: string;
}

const paintFoil = (canvas: HTMLCanvasElement) => {
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return;
	}
	const ratio = window.devicePixelRatio || 1;
	const { width, height } = canvas.getBoundingClientRect();
	canvas.width = Math.floor(width * ratio);
	canvas.height = Math.floor(height * ratio);
	ctx.scale(ratio, ratio);

	// Foil base.
	const gradient = ctx.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, "#9ca3af");
	gradient.addColorStop(0.45, "#e5e7eb");
	gradient.addColorStop(0.55, "#f3f4f6");
	gradient.addColorStop(1, "#6b7280");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);

	// Instructional text on the foil.
	ctx.fillStyle = "rgba(17, 24, 39, 0.55)";
	ctx.font =
		"600 15px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText("Scratch here to reveal", width / 2, height / 2 - 10);
	ctx.font =
		"400 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
	ctx.fillText("🪙 drag across the card", width / 2, height / 2 + 12);
};

export default function ScratchCard({
	code,
	discountLabel,
	headline = "I have a 30% discount. Just scratch this card!",
	caption,
	className,
}: ScratchCardProps) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const scratchingRef = useRef(false);
	// Once the user has scratched, stop auto-repainting the foil on resize so we
	// never wipe their progress (the card can mount mid-animation and grow).
	const dirtyRef = useRef(false);
	const [revealed, setRevealed] = useState(false);
	const [copied, setCopied] = useState(false);

	const clearFoil = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		setRevealed(true);
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}
		paintFoil(canvas);
		// The card can mount while its container is still animating open, so
		// repaint the foil to the real box until the user starts scratching.
		const observer = new ResizeObserver(() => {
			if (!(revealed || dirtyRef.current)) {
				paintFoil(canvas);
			}
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [revealed]);

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
			if (!canvas || revealed) {
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return;
			}
			dirtyRef.current = true;
			const rect = canvas.getBoundingClientRect();
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;
			ctx.globalCompositeOperation = "destination-out";
			ctx.beginPath();
			ctx.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
			ctx.fill();

			if (measureProgress(canvas) >= REVEAL_THRESHOLD) {
				clearFoil();
			}
		},
		[clearFoil, measureProgress, revealed]
	);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			scratchingRef.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);
			scratchAt(event);
		},
		[scratchAt]
	);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLCanvasElement>) => {
			if (!scratchingRef.current) {
				return;
			}
			scratchAt(event);
		},
		[scratchAt]
	);

	const stopScratching = useCallback(() => {
		scratchingRef.current = false;
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

	return (
		<div
			className={cn(
				"relative mx-auto w-full max-w-sm select-none overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-background to-background p-6 shadow-lg",
				className
			)}
		>
			<div className="mb-4 flex items-center justify-center gap-2 text-muted-foreground text-sm">
				<Gift aria-hidden="true" className="size-4 text-primary" />
				<span>{headline}</span>
			</div>

			{/* The reward that sits under the foil. */}
			<div className="relative aspect-[16/9] w-full">
				<div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl border border-primary/30 border-dashed bg-gradient-to-br from-primary/15 to-primary/5 text-center">
					<span className="flex items-center gap-1 font-medium text-primary text-xs uppercase tracking-widest">
						<Sparkles aria-hidden="true" className="size-3" />
						{discountLabel} off
					</span>
					<motion.span
						animate={
							revealed ? { scale: 1, opacity: 1 } : { scale: 0.9, opacity: 0.8 }
						}
						className="mt-1 font-bold font-mono text-3xl text-foreground tracking-widest md:text-4xl"
						transition={{ type: "spring", stiffness: 260, damping: 18 }}
					>
						{code}
					</motion.span>
					<span className="mt-1 text-muted-foreground text-xs">
						Coupon code
					</span>
				</div>

				{/* The scratchable foil overlay. */}
				<canvas
					className={cn(
						"absolute inset-0 size-full rounded-xl transition-opacity duration-500",
						revealed
							? "pointer-events-none opacity-0"
							: "cursor-grab touch-none active:cursor-grabbing"
					)}
					onPointerCancel={stopScratching}
					onPointerDown={handlePointerDown}
					onPointerLeave={stopScratching}
					onPointerMove={handlePointerMove}
					onPointerUp={stopScratching}
					ref={canvasRef}
				/>
			</div>

			<div className="mt-5 flex items-center justify-center gap-2">
				{revealed ? (
					<button
						className={cn(buttonVariants({ variant: "default", size: "sm" }))}
						onClick={handleCopy}
						type="button"
					>
						{copied ? (
							<Check aria-hidden="true" className="size-4" />
						) : (
							<Copy aria-hidden="true" className="size-4" />
						)}
						{copied ? "Copied!" : `Copy ${code}`}
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
			</div>

			{caption ? (
				<p className="mt-3 text-center text-muted-foreground/70 text-xs">
					{caption}
				</p>
			) : null}
		</div>
	);
}
