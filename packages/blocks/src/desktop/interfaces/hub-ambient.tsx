import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Activity,
	CircleAlert,
	CircleCheck,
	House,
	type LucideIcon,
	MessageCircle,
} from "lucide-react";
import { motion } from "motion/react";
import { useId } from "react";
import { type HubClock, type HubGlyph, hubGlyphLabel } from "./hub-model.ts";
import { HUB_EASE, HubStatusLine } from "./hub-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const GLYPH_ICONS: Record<HubGlyph, LucideIcon> = {
	attention: CircleAlert,
	clear: CircleCheck,
	working: Activity,
	"your-turn": MessageCircle,
};

/**
 * The glyph is quiet secondary information, like the reference's weather:
 * drawn in the foreground ink, with one small dot in the state's tone.
 */
const GLYPH_DOT: Record<HubGlyph, string | null> = {
	attention: "bg-destructive",
	clear: null,
	working: "bg-success",
	"your-turn": "bg-primary",
};

/**
 * The ambient screen: a large clock and date in the lower left, with the most
 * urgent state where a smart display shows the weather. The whole surface is
 * one wake target; the home button is the visible, labeled way in.
 */
export function HubAmbient({
	clock,
	clockDateTime,
	date,
	glyph,
	glyphCount,
	inert,
	loading,
	onWake,
	statusLine,
}: {
	clock: HubClock;
	clockDateTime: string;
	date: string;
	glyph: HubGlyph;
	glyphCount: number;
	inert?: boolean;
	loading: boolean;
	onWake: () => void;
	statusLine: string[];
}) {
	const reduceMotion = useReducedMotion();
	const statusId = useId();
	const Icon = GLYPH_ICONS[glyph];
	const glyphLabel = hubGlyphLabel(glyph, glyphCount);
	const dot = GLYPH_DOT[glyph];
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="absolute inset-0 z-10"
			data-testid="hub-ambient"
			exit={{ opacity: 0 }}
			inert={inert}
			initial={{ opacity: 0 }}
			transition={{ duration: reduceMotion ? 0 : 0.36, ease: HUB_EASE }}
		>
			<button
				aria-describedby={statusId}
				aria-label="Wake display"
				className="absolute inset-0 cursor-default outline-none"
				onClick={onWake}
				tabIndex={-1}
				type="button"
			/>
			<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 px-[clamp(1.5rem,5vw,4.5rem)] pb-[clamp(1.5rem,6vh,4rem)]">
				<div className="flex min-w-0 flex-col gap-3">
					<div className="flex items-baseline gap-[clamp(1rem,3vw,2.5rem)]">
						<time
							className="flex items-baseline gap-[0.08em] font-normal text-[clamp(4.5rem,11vw,9rem)] text-foreground tabular-nums leading-[0.85] tracking-[-0.04em]"
							data-testid="hub-clock"
							dateTime={clockDateTime}
						>
							{clock.time}
							{clock.dayPeriod ? (
								<span className="text-[0.2em] tracking-normal">
									{clock.dayPeriod}
								</span>
							) : null}
						</time>
						<p
							className="flex items-baseline gap-[0.3em] text-[clamp(1.75rem,3.6vw,3rem)] text-foreground leading-none"
							data-testid="hub-glyph"
							title={glyphLabel}
						>
							{/* The ring spans the cap height and sits on the clock baseline. */}
							<span className="relative inline-flex size-[0.86em] shrink-0 translate-y-[0.07em] self-baseline">
								<Icon
									aria-hidden="true"
									className="size-full stroke-[1.5] text-foreground/80"
								/>
								{dot ? (
									<span
										aria-hidden="true"
										className={cn(
											"absolute -top-[0.04em] -right-[0.06em] size-[0.22em] rounded-full ring-2 ring-background",
											dot
										)}
									/>
								) : null}
							</span>
							{glyph === "clear" ? null : (
								<span className="tabular-nums">{glyphCount}</span>
							)}
							<span className="sr-only">{glyphLabel}</span>
						</p>
					</div>
					<div className="flex flex-col gap-1 pl-[0.08em]">
						<p className="text-[28px] text-foreground leading-9 tracking-[-0.01em] max-sm:text-[17px] max-sm:leading-6 max-sm:tracking-normal">
							{date}
						</p>
						{loading ? (
							<Skeleton className="my-1 h-4 w-56" radius="pill" />
						) : (
							<HubStatusLine
								className="text-[17px] text-foreground/80 leading-6"
								id={statusId}
								parts={statusLine}
							/>
						)}
					</div>
				</div>
				<Button
					aria-keyshortcuts="Enter"
					aria-label="Show cards"
					className="pointer-events-auto size-12 bg-background/60 text-foreground hover:bg-background/80"
					onClick={onWake}
					size="icon-lg"
					title="Show cards (Enter)"
					type="button"
					variant="ghost"
				>
					<House aria-hidden="true" className="size-5" />
				</Button>
			</div>
		</motion.div>
	);
}
