"use client";

import { Logo } from "./logo.tsx";
import {
	PassCardShell,
	type PassEdge,
	useIsDarkFace,
	WARP_BASE_DARK,
	WARP_BASE_LIGHT,
} from "./pass-card-shell.tsx";
import { type PlanTier, planTierColors, planTierLabel } from "./plan-badge.tsx";
import { AutoFitText, FIT_STEP_PX } from "./waitlist-pass.tsx";

/**
 * The pass a PAID member holds — the same laminated, two-sided, metal-ringed
 * object as the waitlist pass, printed in their tier's own colours.
 *
 * The tier enters through the BACKDROP, not through the type: the warp shader
 * behind the face is fed `planTierColors(plan)`, which is the very stop list
 * inside the plan badge's gradient. So the card's field is the badge a reader
 * already knows from the sidebar, in motion, and there is still exactly one
 * source of tier colour. Body type stays on `text-card-foreground` — the
 * badge's own `ink` is calibrated for an opaque gradient plinth and is
 * unreadable under a 30–55% shader wash.
 *
 * Presentational and side-effect free, like `waitlist-pass.tsx`: it takes an
 * already-resolved plan and an already-formatted date and renders them. It is
 * the live counterpart of `pass-studio`'s tier painter, and the two are kept in
 * step by the ramp constants below rather than by anyone remembering to.
 */

/**
 * The tier label's type ramp. The ceiling is the `text-5xl` (48px) the pass
 * family's hero line has always been set in; the floor is where "Enterprise" —
 * the longest label, and the only one that reaches for it — stops out-ranking
 * the holder name beneath it. Every other label clears the ceiling outright.
 */
export const TIER_LABEL_MAX_PX = 48;
export const TIER_LABEL_MIN_PX = 26;
/**
 * The holder line's ramp. A subtitle, so it starts small and has less room to
 * give — but a real name can be long, and a name is never ours to truncate, so
 * it shrinks on the same measured rule before it is allowed to wrap.
 */
export const TIER_HOLDER_MAX_PX = 18;
export const TIER_HOLDER_MIN_PX = 12;
/**
 * The footer fields. Both sizes are constants applied as inline `fontSize`
 * rather than one constant and one Tailwind class, because `pass-studio`'s tier
 * painter reproduces this footer from these numbers — a size that lived only in
 * a class would leave the painter guessing, which is the exact drift
 * `paint.ts`'s "no independent constants" rule exists to stop.
 */
export const TIER_STAT_VALUE_PX = 20;
export const TIER_META_PX = 12;
/** Re-exported, not re-declared: one ramp step across every pass face. */
export const TIER_FIT_STEP_PX = FIT_STEP_PX;

/**
 * How strongly a TIER card's field is laid over the card face. Light is raised
 * well above the shell's own `WARP_OPACITY_LIGHT`; dark lands on the same
 * number as `WARP_OPACITY_DARK`. Both shell constants stay where they are —
 * they are the waitlist pass's tuning, and it has neither of these problems.
 *
 * The two schemes are asymmetric because the failure is. In light the palette
 * was laid at 30% over a WHITE card, and 30% of a pastel over white is white:
 * `pro`, `teams` and `enterprise` all came out the same pale iridescent sheet,
 * so the card did not name its tier — the badge next to it is an opaque
 * gradient plinth, and the card is supposed to be recognised as that badge. In
 * dark the same stops sit over a near-black face, where they already read as
 * colour rather than as tint, and the constraint runs the OTHER way: `pro`'s
 * near-white pastels are the brightest thing on the card, so pushing them
 * further is what starts erasing `text-card-foreground`. Dark was already at
 * its ceiling; only light had headroom.
 */
/**
 * The same number the shell defaults to today, written out rather than aliased
 * to `WARP_OPACITY_DARK`. Agreeing now is a coincidence, not a contract:
 * aliasing would hand the waitlist pass's next retune straight to the tier card,
 * which is exactly the coupling `warpOpacity` was added to break.
 */
export const TIER_WARP_OPACITY_DARK = 0.55;
export const TIER_WARP_OPACITY_LIGHT = 0.62;

/** Both tier weightings as the shape `PassCardShell.warpOpacity` expects. */
export const TIER_WARP_OPACITY = {
	dark: TIER_WARP_OPACITY_DARK,
	light: TIER_WARP_OPACITY_LIGHT,
} as const;

/**
 * The warp stops for a tier: the badge palette against the scheme's own base
 * tone, bracketed in dark and closed into a ring in light.
 *
 * The base is there so the flow has a settled point where the gradient wraps,
 * rather than strobing across the seam — but in DARK it does a second job the
 * light one cannot: it is the near-black the card's own white type is legible
 * against, so `pro`'s seven near-white pastels still have somewhere dark to
 * cross. Both ends earn their place there.
 *
 * In light the base is `#f2f2f4` — the same near-white as the card face under
 * it. A second one buys no contrast for the dark type, and the two together
 * made the WIDEST stretch of the flow the tone that isn't a tier colour at all:
 * two stops of `pro`'s nine, a third of `desktop-license`'s. So light keeps one
 * and repeats the first colour after it, closing the ring the way
 * `planTierConicGradient` does, and gives the rest of the card back to the
 * badge.
 *
 * Nine stops at the widest (`pro`) either way, against the shader's ceiling of
 * ten, so every tier passes through unreduced.
 */
export function tierWarpColors(plan: PlanTier, isDark: boolean): string[] {
	const colors = planTierColors(plan);
	if (isDark) {
		return [WARP_BASE_DARK, ...colors, WARP_BASE_DARK];
	}
	return [...colors, WARP_BASE_LIGHT, colors[0] ?? WARP_BASE_LIGHT];
}

/**
 * A stable, meaningless seed. `PassCardShell` still requires `ditherSeed`, but
 * on a tier card `warpColors` overrides the only thing the seed would have
 * coloured, so it is inert — this exists so the value passed is at least not a
 * lie about what the card is, and is stable across renders (a fresh seed each
 * render would rehash the backdrop for nothing).
 */
export function tierPassSeed(plan: PlanTier, holder?: string | null): string {
	return `${plan}:${holder?.trim() || "ryu"}`;
}

export interface TierPassProps {
	className?: string;
	/**
	 * {@link PassEdge}. `"live"` for the one hero card on a screen; the default
	 * brushed ramp for anything that appears more than once, since `"live"`
	 * costs a metal-fx instance per plane of the milled edge.
	 */
	edge?: PassEdge;
	/** Name printed on the card. Falsy → the card reads as an unpersonalised specimen. */
	holder?: string | null;
	/**
	 * Which tuning of the metal ring to paint, and the scheme the warp's base
	 * tone is picked from. `"auto"` follows `prefers-color-scheme`, which is
	 * wrong wherever the app has a manual theme toggle that can disagree with the
	 * OS — callers pass their resolved theme. Kept as a prop rather than read
	 * from `next-themes` here so the UI package stays consumer-agnostic.
	 */
	metalTheme?: "auto" | "dark" | "light";
	plan: PlanTier;
	/** Already-formatted date, e.g. "Aug 2026". The card prints it verbatim. */
	since?: string | null;
	/**
	 * Kill the card's self-motion — the idle turn, the float, and the
	 * drag-to-rotate. Mandatory anywhere another gesture reads the same pointer
	 * (the cut-to-cancel dialog), since `still` is also what returns
	 * `touch-action` to the page.
	 */
	still?: boolean;
}

/**
 * One labelled fact in the footer: value above its label, sentence case, the
 * same treatment the waitlist pass gives its position readout. The number (or
 * word) is what is worth reading; the label only says which fact it is.
 */
function TierStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col">
			<span
				className="truncate font-medium leading-none"
				style={{ fontSize: `${TIER_STAT_VALUE_PX}px` }}
			>
				{value}
			</span>
			<span
				className="truncate text-muted-foreground"
				style={{ fontSize: `${TIER_META_PX}px` }}
			>
				{label}
			</span>
		</div>
	);
}

export function TierPass({
	className,
	edge = "brushed",
	holder,
	metalTheme = "auto",
	plan,
	since,
	still = false,
}: TierPassProps) {
	// Resolved HERE and handed down, rather than each consumer reading the
	// scheme for itself: `useIsDarkFace` subscribes, so the card repaints when
	// the OS toggle flips instead of holding a palette sampled once at mount.
	const isDark = useIsDarkFace(metalTheme);
	const label = planTierLabel(plan);
	const name = holder?.trim() ?? "";

	return (
		<PassCardShell
			backdrop="warp"
			className={className}
			ditherSeed={tierPassSeed(plan, holder)}
			edge={edge}
			metalTheme={metalTheme}
			// `ringed` is left at its default of on. The waitlist pass withholds the
			// chrome edge until a handle is claimed, because there the ring is what
			// the reserve step pays out; a paid tier has nothing left to earn, so it
			// arrives as a finished object.
			still={still}
			warpColors={tierWarpColors(plan, isDark)}
			warpOpacity={TIER_WARP_OPACITY}
		>
			<div className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7">
				{/* Wordmark alone. The waitlist card puts its join date opposite the
				    lockup; here that date is a LABELLED field in the footer, and
				    printing the same fact twice unlabelled on a 320px card reads as a
				    layout that lost track of itself. */}
				<div className="flex items-center gap-2">
					<Logo size="20px" variant="outline" />
					<span className="font-medium text-sm">Ryu</span>
				</div>

				<div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5">
					<AutoFitText
						className="font-medium leading-[1.02] tracking-tight"
						maxPx={TIER_LABEL_MAX_PX}
						minPx={TIER_LABEL_MIN_PX}
						stepPx={TIER_FIT_STEP_PX}
					>
						{label}
					</AutoFitText>
					{/* No placeholder for a missing holder. An empty-state line under
					    the hero reads as a defect on a card whose whole job is to look
					    like a finished object — without a name the card is simply a
					    specimen of the tier, which is exactly what a pricing surface
					    wants to show. */}
					{name ? (
						<AutoFitText
							className="text-muted-foreground"
							maxPx={TIER_HOLDER_MAX_PX}
							minPx={TIER_HOLDER_MIN_PX}
							stepPx={TIER_FIT_STEP_PX}
						>
							{name}
						</AutoFitText>
					) : null}
				</div>

				{/* The card's two facts as labelled fields. "Plan" prints the bare
				    label rather than the fuller "Ryu Enterprise": each column is about
				    124px at the card's own width, which the longer form overruns into
				    an ellipsis — and an elided plan name on the card that certifies the
				    plan is worse than saying the hero word twice. */}
				<div className="grid grid-cols-2 gap-3">
					<TierStat label="Plan" value={label} />
					<TierStat label="Member since" value={since?.trim() || "—"} />
				</div>
			</div>
		</PassCardShell>
	);
}
