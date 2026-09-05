"use client";

import { formatCount } from "@ryu/ui/lib/number-format.ts";

import { EntityAvatar } from "./entity-avatar.tsx";
import { Logo } from "./logo.tsx";
import { PassCardShell, type PassEdge } from "./pass-card-shell.tsx";
import { AutoFitText, FIT_STEP_PX } from "./waitlist-pass.tsx";

/**
 * The WRAPPED pass — the fourth face of the pass family (`waitlist-pass` was
 * the first, `tier-pass` the second, `referral-pass` the third), built on the
 * same `PassCardShell`: the laminated, two-sided, metal-ringed object that
 * turns, tilts, floats and can be dragged by hand.
 *
 * It is the card a Ryu member shows off for their year: the same object the
 * waitlist and referral surfaces already proved makes membership feel like a
 * club, pressed into service for the annual snapshot. The hero is the member's
 * own name (the thing that makes the card theirs), the warp backdrop is seeded
 * off it so no two people get the same card, and the footer carries the four
 * numbers worth bragging about — tokens, agent hours, best streak, top model.
 *
 * Presentational and side-effect free, like the other three faces: it takes the
 * already-resolved stats and renders them. All colour comes from design tokens
 * so it reads correctly in light and dark.
 */

/**
 * The name line's type ramp. Same ceiling and floor as the waitlist pass — a
 * name is never ours to truncate, and the family's hero line is 48px.
 */
export const WRAPPED_NAME_MAX_PX = 48;
export const WRAPPED_NAME_MIN_PX = 26;
/**
 * The streak/level line's ramp. A subtitle, so it starts small and has less
 * room to give, like every other face's holder line.
 */
export const WRAPPED_SUB_MAX_PX = 16;
export const WRAPPED_SUB_MIN_PX = 11;
/** Footer field sizes, matching the tier and referral cards' so the family
 * stays one object. */
export const WRAPPED_STAT_VALUE_PX = 20;
export const WRAPPED_META_PX = 12;
/** Re-exported, not re-declared: one ramp step across every pass face. */
export const WRAPPED_FIT_STEP_PX = FIT_STEP_PX;

/** The year printed in the header kicker. Baked in, like the pass family's
 * serials — a Wrapped card is a record of a specific year. */
export const WRAPPED_YEAR = 2026;

export interface WrappedPassProps {
	agentHours?: number;
	/** The member's own picture; the same precedence the waitlist pass uses. */
	avatarUrl?: string | null;
	className?: string;
	/**
	 * {@link PassEdge}. `"live"` for the one hero card on a screen; the brushed
	 * default anywhere the card appears more than once, since `"live"` costs a
	 * metal-fx instance per plane of the milled edge.
	 */
	edge?: PassEdge;
	level?: number;
	/**
	 * Which tuning of the metal ring to paint. `"auto"` follows
	 * `prefers-color-scheme`, which is wrong wherever the app has a manual theme
	 * toggle that can disagree with the OS — callers pass their resolved theme.
	 */
	metalTheme?: "auto" | "dark" | "light";
	/** Display name — the hero of the card. */
	name?: string | null;
	/**
	 * Kill the card's self-motion — the idle turn, the float, and
	 * drag-to-rotate. Needed anywhere another gesture reads the same pointer.
	 */
	still?: boolean;
	/** The streak the holder has right now, shown under the name. */
	streakCurrent?: number;
	/** The longest streak of the year, shown in the footer. */
	streakLongest?: number;
	topModel?: string | null;
	totalTokens?: number;
}

/**
 * One labelled fact in the footer: value above its label, the same treatment
 * the referral and tier cards give their stats.
 */
function WrappedStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col">
			<span
				className="truncate font-medium font-mono tabular-nums leading-none"
				style={{ fontSize: `${WRAPPED_STAT_VALUE_PX}px` }}
			>
				{value}
			</span>
			<span
				className="truncate text-muted-foreground"
				style={{ fontSize: `${WRAPPED_META_PX}px` }}
			>
				{label}
			</span>
		</div>
	);
}

export function WrappedPass({
	avatarUrl,
	className,
	edge = "live",
	level = 0,
	metalTheme = "auto",
	name,
	streakCurrent = 0,
	streakLongest = 0,
	totalTokens = 0,
	agentHours = 0,
	topModel,
	still = false,
}: WrappedPassProps) {
	// Seeded off the NAME so the card is the member's own colour and two people
	// never hold the same one. Falls back to a stable literal rather than a fresh
	// value per render, which would rehash the backdrop on every paint for nothing.
	const displayName = name?.trim() || "A Ryu Developer";
	const seed = displayName;

	return (
		<PassCardShell
			backdrop="warp"
			className={className}
			ditherSeed={seed}
			edge={edge}
			metalTheme={metalTheme}
			// Left at its default of on, unlike the waitlist pass. That card
			// withholds the chrome edge until a handle is claimed, because there
			// the ring is what the reserve step pays out; a Wrapped card has
			// nothing left to earn — it is the finished object being shared.
			still={still}
		>
			<div className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7">
				{/* Wordmark left, what the card IS right. The kicker carries the year
				    rather than a date: a Wrapped card is a record of one year, and
				    "Wrapped · 2026" tells a reader who has been handed this what they
				    are looking at in two words. */}
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2">
						<Logo size="20px" variant="outline" />
						<span className="font-medium text-sm">Ryu</span>
					</span>
					<span className="text-[11px] text-muted-foreground uppercase tracking-widest">
						Wrapped · {WRAPPED_YEAR}
					</span>
				</div>

				<div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5">
					{/* ONLY when the member has actually set a picture, for the same
					    reason the waitlist pass gates its circle: the generative glyph
					    is seeded off a different key than the card's backdrop, so an
					    un-keyed fallback here would read as a foreign object stuck on
					    someone else's card. With no picture the name simply carries
					    the card. */}
					{avatarUrl ? (
						<EntityAvatar
							className="mb-3 size-14 shrink-0 border border-border/60 bg-background/70 backdrop-blur-sm"
							name={displayName}
							seed={seed}
							src={avatarUrl}
						/>
					) : null}
					<AutoFitText
						className="font-medium leading-[1.02] tracking-tight"
						maxPx={WRAPPED_NAME_MAX_PX}
						minPx={WRAPPED_NAME_MIN_PX}
						stepPx={WRAPPED_FIT_STEP_PX}
					>
						{displayName}
					</AutoFitText>
					{/* The level and current streak — the two live facts, like the
					    header of the settings stats tab. The LONGEST streak sits in
					    the footer instead, so nothing is printed twice. */}
					<AutoFitText
						className="text-muted-foreground"
						maxPx={WRAPPED_SUB_MAX_PX}
						minPx={WRAPPED_SUB_MIN_PX}
						stepPx={WRAPPED_FIT_STEP_PX}
					>
						{`Level ${level} · ${streakCurrent}-day streak`}
					</AutoFitText>
				</div>

				{/* The four numbers worth bragging about. Zero is printed, not
				    hidden, exactly as the referral pass prints "0 joined": it is
				    the honest starting state. */}
				<div className="grid grid-cols-2 gap-3">
					<WrappedStat label="Tokens" value={formatCount(totalTokens) ?? "—"} />
					<WrappedStat
						label="Agent hours"
						value={`${agentHours.toFixed(1)}h`}
					/>
					<WrappedStat label="Best streak" value={`${streakLongest}d`} />
					<WrappedStat label="Top model" value={topModel?.trim() || "Ryu"} />
				</div>
			</div>
		</PassCardShell>
	);
}

export default WrappedPass;
