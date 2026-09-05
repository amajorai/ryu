"use client";

import { Logo } from "./logo.tsx";
import { PassCardShell, type PassEdge } from "./pass-card-shell.tsx";
import { AutoFitText, FIT_STEP_PX } from "./waitlist-pass.tsx";

/**
 * The INVITE PASS — the card a member hands to someone else.
 *
 * The third face of the pass family (`waitlist-pass` was the first, `tier-pass`
 * the second), built on the same `PassCardShell`: the laminated, two-sided,
 * metal-ringed object that turns, tilts, floats and can be dragged by hand. It
 * exists because the referral surfaces had a read-only `<Input>` with a Copy
 * button next to it, which is a form, and a form is not a thing anyone shows a
 * friend. The waitlist queue already proved the opposite: the pass is what makes
 * membership feel like a club, and an invite is the one artefact in the product
 * whose entire job is to be shown to another person.
 *
 * THE HERO IS THE CODE, not the link. A URL cannot be set at 48px without
 * shrinking to unreadable or wrapping to three lines, and it is not what the
 * recipient repeats out loud. The full link is still what the Copy button puts
 * on the clipboard — the card is the object, the button is the transport.
 *
 * Presentational and side-effect free, like both other faces: it takes an
 * already-resolved code and already-formatted stats and renders them.
 */

/**
 * The code line's type ramp. Ceiling is the 48px every pass hero is set in;
 * floor is where a long code stops out-ranking the holder name beneath it. Codes
 * are short, so most clear the ceiling outright — the ramp is here for the
 * custom ones.
 */
export const REFERRAL_CODE_MAX_PX = 48;
export const REFERRAL_CODE_MIN_PX = 22;
/** The holder line. A subtitle, and a name is never ours to truncate. */
export const REFERRAL_HOLDER_MAX_PX = 16;
export const REFERRAL_HOLDER_MIN_PX = 11;
/** Footer field sizes, matching the tier card's so the family stays one object. */
export const REFERRAL_STAT_VALUE_PX = 20;
export const REFERRAL_META_PX = 12;
/** Re-exported, not re-declared: one ramp step across every pass face. */
export const REFERRAL_FIT_STEP_PX = FIT_STEP_PX;

export interface ReferralPassProps {
	className?: string;
	/**
	 * The share code, without any `/r/` prefix. Falsy renders the card as an
	 * unfinished specimen — see the note on the hero below.
	 */
	code?: string | null;
	/** What the referrer has earned so far, already formatted ("$45"). */
	earned?: string | null;
	/**
	 * {@link PassEdge}. `"live"` for the one hero card on a screen; the brushed
	 * default anywhere the card appears more than once, since `"live"` costs a
	 * metal-fx instance per plane of the milled edge.
	 */
	edge?: PassEdge;
	/** Name printed under the code. Falsy → the card is unpersonalised. */
	holder?: string | null;
	/** How many people have joined through this code. */
	joined?: number | null;
	/**
	 * Which tuning of the metal ring to paint. `"auto"` follows
	 * `prefers-color-scheme`, which is wrong wherever the app has a manual theme
	 * toggle that can disagree with the OS — callers pass their resolved theme.
	 */
	metalTheme?: "auto" | "dark" | "light";
	/**
	 * Kill the card's self-motion — the idle turn, the float, and
	 * drag-to-rotate. Needed anywhere another gesture reads the same pointer.
	 */
	still?: boolean;
}

/**
 * One labelled fact in the footer: value above its label, the same treatment
 * both other faces give their stats.
 */
function ReferralStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col">
			<span
				className="truncate font-medium font-mono tabular-nums leading-none"
				style={{ fontSize: `${REFERRAL_STAT_VALUE_PX}px` }}
			>
				{value}
			</span>
			<span
				className="truncate text-muted-foreground"
				style={{ fontSize: `${REFERRAL_META_PX}px` }}
			>
				{label}
			</span>
		</div>
	);
}

export function ReferralPass({
	className,
	code,
	edge = "live",
	earned,
	holder,
	joined,
	metalTheme = "auto",
	still = false,
}: ReferralPassProps) {
	const trimmedCode = code?.trim() ?? "";
	const name = holder?.trim() ?? "";
	// Seeded off the CODE, so the card is the member's own colour and two people
	// never hold the same one. Falls back to a stable literal rather than a fresh
	// value per render, which would rehash the backdrop on every paint for nothing.
	const seed = trimmedCode || "ryu";

	return (
		<PassCardShell
			backdrop="warp"
			className={className}
			ditherSeed={seed}
			edge={edge}
			// No pointer glare on this face. The hero here is a CODE someone is meant
			// to read off the card and repeat, and a white highlight sweeping over it
			// on hover is a wash across the one string that matters. The lift and the
			// shadow still answer the pointer.
			glare={false}
			metalTheme={metalTheme}
			// The ring is withheld until the code exists, for the same reason the
			// waitlist pass withholds it until a handle is claimed: an unfinished card
			// should not arrive wearing the chrome that marks a finished one.
			ringed={Boolean(trimmedCode)}
			still={still}
		>
			<div className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7">
				{/* Wordmark left, what the card IS right. Unlike the waitlist pass this
				    header carries a kicker rather than a date: a reader who has been
				    handed this card has no idea what it is for, and "Invite" is the one
				    word that tells them. */}
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2">
						<Logo size="20px" variant="outline" />
						<span className="font-medium text-sm">Ryu</span>
					</span>
					<span className="text-[11px] text-muted-foreground uppercase tracking-widest">
						Invite
					</span>
				</div>

				<div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5">
					<AutoFitText
						className="font-medium leading-[1.02] tracking-tight"
						maxPx={REFERRAL_CODE_MAX_PX}
						minPx={REFERRAL_CODE_MIN_PX}
						stepPx={REFERRAL_FIT_STEP_PX}
					>
						{/* An em dash rather than "Generating…": the hero of a card is not
						    a status line, and a spinner word set at 48px reads as the card
						    being broken rather than as the code being on its way. */}
						{trimmedCode || "—"}
					</AutoFitText>
					{name ? (
						<AutoFitText
							className="text-muted-foreground"
							maxPx={REFERRAL_HOLDER_MAX_PX}
							minPx={REFERRAL_HOLDER_MIN_PX}
							stepPx={REFERRAL_FIT_STEP_PX}
						>
							{`Invited by ${name}`}
						</AutoFitText>
					) : null}
				</div>

				{/* The two facts a referrer actually watches. Zero is printed, not
				    hidden: "0 joined" is the honest starting state and the thing the
				    card is asking them to change, whereas an absent row would read as a
				    card that does not track it at all. */}
				<div className="grid grid-cols-2 gap-3">
					<ReferralStat label="Joined" value={String(joined ?? 0)} />
					<ReferralStat label="Earned" value={earned?.trim() || "—"} />
				</div>
			</div>
		</PassCardShell>
	);
}

export default ReferralPass;
