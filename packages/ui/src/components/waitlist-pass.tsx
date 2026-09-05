"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { EntityAvatar } from "./entity-avatar.tsx";
import { Logo } from "./logo.tsx";
import { PassCardShell } from "./pass-card-shell.tsx";

/**
 * The membership pass a queued user sees on the waitlist screens (web
 * `waitlist-view.tsx` and desktop `WaitlistPage.tsx`). One definition, two
 * consumers — the card is what makes the queue feel like a club rather than a
 * form, so it must look identical everywhere it appears.
 *
 * Presentational and side-effect free: it takes the already-resolved queue facts
 * and renders them. All colour comes from design tokens so it reads correctly in
 * light and dark.
 *
 * Motion: a slow unbroken turn that shows the back of the pass once a cycle, a
 * mouse-tracked 3D tilt with a specular glare on hover, and click-and-drag (or
 * touch-and-drag) to turn it by hand. All of it is suppressed under
 * `prefers-reduced-motion` — the pass is decoration, and decoration is the first
 * thing that should stop moving when a user asks for less of it. The pass is
 * two-sided: the front carries the member's details, the back only the Ryu
 * mark.
 *
 * The border is `metal-fx` (the same shader the onboarding "Use Ryu Cloud"
 * button wears), which paints an animated metallic ring around whatever it
 * wraps. It sits INSIDE the rotating element rather than around it: the ring is
 * a canvas positioned over the measured child, so it only travels with the turn
 * when a common ancestor carries the transform.
 *
 * The card face is printed on the `warp` shader, coloured from the member's own
 * seed (`backdrop="warp"`), with their dither glyph moved off the backdrop and
 * into a circle above the name. The glyph as a full-bleed texture was a pattern
 * you had to be told was yours; a portrait-shaped one is read as an avatar
 * without explanation, and the flowing backdrop it left behind carries the same
 * seeded hue, so the two still say the same thing about whose card this is. The
 * employee badge keeps the glyph backdrop — see `PassBackdrop`.
 */

export const QUEUE_STATS_MIN = 500;
/**
 * The name line's type ramp. The ceiling is the `text-5xl` (48px) the hero was
 * fixed at; the floor is the size below which the name stops out-ranking the
 * handle under it and starts reading as body copy. Stepping by 2px is finer
 * than anyone can see and keeps the search to at most eleven measurements.
 */
export const NAME_MAX_PX = 48;
export const NAME_MIN_PX = 26;
/**
 * The handle line's ramp. A reserved handle can run to 32 characters, which at
 * the `text-base` it was set in overran the card and was cut off with an
 * ellipsis — the one thing a handle must never be, since a truncated one is not
 * the handle. It shrinks on the same rule as the name, just over a shorter
 * range: it is a subtitle, so it starts small and has less room to give.
 */
export const HANDLE_MAX_PX = 16;
export const HANDLE_MIN_PX = 11;
/** 2px is finer than anyone can see, and keeps each search to a dozen measurements. */
export const FIT_STEP_PX = 2;
const SERIAL_LENGTH = 6;
const NON_ALPHANUMERIC = /[^a-zA-Z0-9]/g;

export interface WaitlistPassProps {
	/**
	 * Canonical dither seed for this member — `ditherAvatarSeed({ id, email,
	 * name })`, the precedence every other surface keys on. Pass it and the card
	 * draws the SAME placeholder glyph as the account menu trigger. Omit it (the
	 * public `/pass` page has no session) and the card falls back to the handle,
	 * which is all a reader of a shared card has anyway.
	 */
	avatarSeed?: string | null;
	/**
	 * The member's own picture, if they have set one. It wins over the generative
	 * glyph, exactly as it does in the account menu — the card should show the
	 * same face the rest of the app shows them.
	 */
	avatarUrl?: string | null;
	className?: string;
	/** Sign-up time (ISO). Rendered as the "member since" date. */
	joinedAt?: string | null;
	/**
	 * Which tuning of the metal ring to paint. `"auto"` follows
	 * `prefers-color-scheme`, which is wrong wherever the app has a manual theme
	 * toggle that can disagree with the OS — both waitlist screens pass their
	 * resolved theme instead. Kept as a prop rather than read from `next-themes`
	 * here so the UI package stays consumer-agnostic.
	 */
	metalTheme?: "auto" | "dark" | "light";
	/** Display name on the pass. Falls back to the handle, then to "Member". */
	name?: string | null;
	/** 1-based queue position; null while it is still loading or unknown. */
	position?: number | null;
	/**
	 * Accepted but unused, like `avatarUrl`: the referral count came off the card
	 * because it is a private number about your own account, and a pass is made to
	 * be shown to other people. The waitlist screen still displays it.
	 */
	referralCount?: number;
	/**
	 * Accepted but unused: the serial came off the card with the "early access"
	 * header line. `formatPassSerial` is still exported for the share image, which
	 * does still carry one.
	 */
	serialSeed?: string | null;
	/**
	 * Queue size. No longer printed on the card, but it gates the position
	 * readout: see `QUEUE_STATS_MIN`.
	 */
	totalWaiting?: number | null;
	/** Reserved handle, without the leading "@". */
	username?: string | null;
}

/**
 * A stable, human-readable pass serial like "A1B2C3". No "RYU-" prefix: the
 * card already says Ryu on the line above it and again on its back.
 */
export const formatPassSerial = (seed: string | null | undefined): string => {
	const compact = (seed ?? "").replace(NON_ALPHANUMERIC, "").toUpperCase();
	return (compact || "000000")
		.slice(0, SERIAL_LENGTH)
		.padEnd(SERIAL_LENGTH, "0");
};

/** "Jan 5, 2026" from an ISO stamp; null for missing or unparseable input. */
export const formatPassDate = (
	iso: string | null | undefined
): string | null => {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	// Date AND time. A pass is a record of a moment, and on an early-access queue
	// the minute you joined is the part worth bragging about.
	return `${date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	})}, ${date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
};

/**
 * A LinkedIn share URL. Unlike x.com's intent endpoint it takes no text —
 * LinkedIn composes the post from the target page's Open Graph tags, which is
 * exactly what `/pass` serves.
 */
export const linkedInShareUrl = (url: string): string =>
	`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;

/**
 * An x.com compose URL. Used by both waitlist screens for the share action; the
 * caller decides how to open it (a browser `window.open`, or the desktop's
 * `openExternal`, which must not navigate the app window away).
 */
export const xShareIntentUrl = (text: string, url?: string | null): string => {
	const params = new URLSearchParams({ text });
	if (url) {
		params.set("url", url);
	}
	return `https://x.com/intent/tweet?${params.toString()}`;
};

/**
 * The share copy, kept next to the intent helper so both screens say the same
 * thing. It says what Ryu IS, not just that a queue exists: most people seeing
 * the post have never heard the name, and "I got spot #42" tells them nothing
 * they could act on.
 */
const RYU_PITCH = "Ryu is end-to-end infrastructure for AI agents.";
export const waitlistShareText = (
	position: number | null | undefined
): string =>
	typeof position === "number"
		? `I just claimed spot #${position} on the Ryu waitlist. ${RYU_PITCH}`
		: `I just claimed my spot on the Ryu waitlist. ${RYU_PITCH}`;

/**
 * The name line, scaled to the card. It starts at the `text-5xl` the hero was
 * always set in and steps down only as far as it has to, one line, until either
 * it fits or it hits the floor — at which point it wraps rather than shrinking
 * into the body copy. A name is the one thing on this card that is not ours to
 * truncate, and "Bartholomew Featherstonehaugh" set at the same size as "Ana"
 * either overflowed the card or wrapped to three lines and pushed the footer
 * off it.
 *
 * Measured rather than computed from character count: the face is a variable
 * font, so a count-based guess is wrong by a wide margin for narrow or wide
 * names, and the card is rendered at more than one width (the queue screen, the
 * public `/pass` page, the desktop panel).
 *
 * Exported for the pass's OTHER faces (`tier-pass.tsx`) — not because a second
 * card wants a different ramp, but because `pass-studio`'s painters reproduce
 * this exact loop with `measureText` standing in for `scrollWidth`, so a face
 * that fitted its type any other way would silently disagree with its own
 * export.
 */
export function AutoFitText({
	children,
	className,
	maxPx,
	minPx,
	stepPx = FIT_STEP_PX,
}: {
	children: string;
	className?: string;
	maxPx: number;
	minPx: number;
	stepPx?: number;
}) {
	const nodeRef = useRef<HTMLSpanElement>(null);
	const [fontPx, setFontPx] = useState(maxPx);
	const [wrapped, setWrapped] = useState(false);

	// Layout effect, not effect: this runs between the DOM write and the paint,
	// so the name never flashes at the wrong size on the way to the right one.
	useLayoutEffect(() => {
		const node = nodeRef.current;
		const host = node?.parentElement;
		if (!(node && host)) {
			return;
		}
		const fitToWidth = () => {
			const available = host.clientWidth;
			if (available === 0) {
				return;
			}
			// Measure on one line at every step — a wrapped line always "fits" by
			// width, so there would be nothing left to measure against.
			node.style.whiteSpace = "nowrap";
			let size = maxPx;
			node.style.fontSize = `${size}px`;
			// `Math.max` rather than a bare subtraction: a step that does not divide
			// the range evenly would otherwise undershoot the floor on its last
			// pass, which is how the handle line ended up a pixel under its minimum.
			while (size > minPx && node.scrollWidth > available) {
				size = Math.max(minPx, size - stepPx);
				node.style.fontSize = `${size}px`;
			}
			const overflowsAtFloor = node.scrollWidth > available;
			// Only `whiteSpace` is dropped — the class owns it. `fontSize` is LEFT
			// on the node at the size just measured, because it is also what the
			// next render writes: clearing it made the element inherit 16px and
			// stay there, since React sees its own unchanged `fontSize` prop and
			// writes nothing back.
			node.style.whiteSpace = "";
			setFontPx(size);
			setWrapped(overflowsAtFloor);
		};
		fitToWidth();
		const observer = new ResizeObserver(fitToWidth);
		observer.observe(host);
		return () => observer.disconnect();
	}, [children, maxPx, minPx, stepPx]);

	return (
		<span
			className={cn(
				"block",
				wrapped ? "break-words" : "whitespace-nowrap",
				className
			)}
			ref={nodeRef}
			style={{ fontSize: `${fontPx}px` }}
		>
			{children}
		</span>
	);
}

export function WaitlistPass({
	avatarSeed,
	avatarUrl,
	className,
	joinedAt,
	metalTheme = "auto",
	name,
	position,
	totalWaiting,
	username,
}: WaitlistPassProps) {
	const displayName = name?.trim() || (username ? `@${username}` : "Member");
	// When there is no name the hero falls back to the handle — which is right on
	// the public `/pass` page, where there is no session to read a name from. What
	// is never right is printing it TWICE: a card reading "@jay" over "@jay" looks
	// like a rendering fault, and it is reachable on the live queue too, for the
	// window where the session's name has not arrived yet. Suppress the handle
	// line exactly when the hero already IS the handle.
	const showHandle = Boolean(username) && displayName !== `@${username}`;
	const memberSince = formatPassDate(joinedAt);
	const showPosition =
		typeof totalWaiting === "number" && totalWaiting > QUEUE_STATS_MIN;
	// TWO seeds, deliberately, because the two things they colour answer
	// different questions.
	//
	// The backdrop follows the HANDLE first: it is the name the member chose, so
	// claiming one has to repaint the card — that moment is the whole reward of
	// reserving a handle, and a card that did not change would read as the claim
	// not having worked.
	const backdropSeed = username || name?.trim() || "ryu";
	// The glyph in the circle follows the canonical avatar seed (id, then email,
	// then name) so it is the SAME placeholder the account menu trigger draws —
	// an avatar that disagreed with the one in the corner of the app would read
	// as two different people. Falls back to the handle on the public `/pass`
	// page, which has no session to key on.
	const glyphSeed = avatarSeed || backdropSeed;

	return (
		<PassCardShell
			backdrop="warp"
			className={className}
			ditherSeed={backdropSeed}
			edge="live"
			metalTheme={metalTheme}
			// No chrome until the handle is claimed: the metal edge is what the
			// reserve step pays out, so a pass that arrives already finished has
			// nothing left to earn.
			ringed={Boolean(username)}
		>
			{/* `min-h` rather than a fixed height: the name is the hero and can
		    wrap to two or three lines, so the card grows past the floor
		    instead of clipping. The hero block takes the slack (`flex-1`),
		    which is what keeps a short name from leaving the footer
		    floating in the middle of the card. */}
			<div className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7">
				{/* Wordmark left, join date right. The serial and the "early
				    access" line are gone: neither is something the owner or a
				    reader of a shared card ever needs, and they were crowding
				    the one thing the header should carry — whose card this is
				    and how long they have been here. */}
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2">
						<Logo size="20px" variant="outline" />
						<span className="font-medium text-sm">Ryu</span>
					</span>
					<span className="text-[11px] text-muted-foreground tabular-nums">
						{memberSince ?? ""}
					</span>
				</div>

				<div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5">
					{/* The member's glyph, in a circle, directly above their name — the
					    shape a reader already knows means "this person". The ring and
					    the tinted disc under it are what keep it legible against a
					    shader backdrop that is itself in the glyph's own hue. */}
					{/* ONLY when the member has actually set a picture. The generative
					    glyph is deliberately NOT used as the fallback here: it is seeded
					    off the canonical avatar seed (id, then email, then name) while
					    the card's backdrop is seeded off the HANDLE, so the two never
					    agree on a hue and the circle read as a foreign object stuck on
					    someone else's card. With no picture the name simply carries the
					    card, which is what it did before the circle existed. */}
					{avatarUrl ? (
						<EntityAvatar
							className="mb-3 size-14 shrink-0 border border-border/60 bg-background/70 backdrop-blur-sm"
							name={displayName}
							seed={glyphSeed}
							src={avatarUrl}
						/>
					) : null}
					<AutoFitText
						className="font-medium leading-[1.02] tracking-tight"
						maxPx={NAME_MAX_PX}
						minPx={NAME_MIN_PX}
					>
						{displayName}
					</AutoFitText>
					{/* No placeholder for an unclaimed handle: an empty-state line
					    under the name reads as a defect on a card whose whole job
					    is to look like a finished object. The reserve field on the
					    screen beside it is what prompts the claim. */}
					{showHandle ? (
						<AutoFitText
							className="text-muted-foreground"
							maxPx={HANDLE_MAX_PX}
							minPx={HANDLE_MIN_PX}
						>
							{`@${username}`}
						</AutoFitText>
					) : null}
				</div>

				{/* Position alone. Value above its label, sentence case: the
				    number is the fact worth reading and the word only says which
				    fact it is. Referrals moved off the card — it is a private
				    number about your own account, not something to hand to
				    everyone who sees a shared pass. */}
				{showPosition ? (
					<div className="flex flex-col">
						<span className="font-medium text-xl tabular-nums leading-none">
							#{position ?? "—"}
						</span>
						<span className="text-muted-foreground text-xs">Position</span>
					</div>
				) : null}
			</div>
		</PassCardShell>
	);
}
