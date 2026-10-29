// packages/marketplace/src/likes/like-button.tsx
//
// THE like control. A heart and a number, and nothing else.
//
// GHOST MEANS BARE. No border, no background, no pill, no hover wash, no "Like"
// text. That is why this is a raw <button> with utility classes and NOT
// `<Button variant="ghost">` from @ryu/ui: shadcn's ghost still ships height,
// padding, rounding and a hover background, which is exactly the chrome this
// control must not have. The only affordances are the heart filling and the
// count moving.
//
// THE POP SCALE IS ON A WRAPPER <span>, NEVER ON THE <svg>. This is the first of
// the two load-bearing notes in the supplied CSS and it is not stylistic:
// transforming an inline SVG makes Chromium rasterise it at 1x, so the heart
// goes visibly pixelated on a hi-DPI display for the duration of every pop.
// `.t-like-icon` wraps the svg and carries the animation; the svg is untouched.
//
// `.is-bursting` IS ADDED AND THEN REMOVED. The second note. A CSS animation only
// restarts when the class that applies it is re-added, so leaving `.is-bursting`
// on means the first like animates and every like after it does nothing. The
// class is stripped after the longest particle duration + delay (`BURST_MAX_MS`),
// which re-arms it.
//
// The stylesheet itself lives in `packages/ui/src/styles/globals.css` — the one
// sheet both apps/desktop and apps/web import — alongside every other
// Transitions.dev animation in the design system. See the block comment there.

import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useItemLike } from "./likes-provider.tsx";
import { BURST_MAX_MS, burstParticles } from "./likes-store.ts";

/** How many particle dots the CSS expects. Eight, per the supplied sheet. */
const PARTICLE_COUNT = 8;
const PARTICLE_KEYS = Array.from(
	{ length: PARTICLE_COUNT },
	(_, i) => `like-particle-${i}`
);

/** Shared display policy for a count beside the like control. */
export function formatLikeCount(count: number): string {
	return formatSharedCount(count) ?? "—";
}

/**
 * The heart + count for one listing, keyed by its NAMESPACE (`@ryu/crm`,
 * `owner/repo`) — the scoped public id, never an internal row id, so a
 * community/GitHub listing with no marketplace document of its own is just as
 * likeable as a published one.
 *
 * Renders NOTHING when no likes service is mounted above it, so a harness or a
 * surface with no control-plane binding does not show a dead heart.
 */
export default function ItemLikeButton({
	namespace,
	seed,
	className,
	stopPropagation = true,
}: {
	namespace: string | null | undefined;
	/** `likeCount` / `likedByMe` from the list response, when the surface's feed
	 *  carries them. Seeding is what stops a grid flashing unliked→liked. */
	seed?: { count: number; liked?: boolean | null } | null;
	className?: string;
	/** Stop the click reaching an enclosing row. True on a card (where the row
	 *  opens the listing); a detail view can pass false. */
	stopPropagation?: boolean;
}) {
	const like = useItemLike(namespace, seed);
	const [bursting, setBursting] = useState(false);
	const particlesRef = useRef<HTMLSpanElement | null>(null);
	const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (burstTimer.current) {
				clearTimeout(burstTimer.current);
			}
		},
		[]
	);

	const fire = useCallback(() => {
		const host = particlesRef.current;
		if (host) {
			// Per-particle vectors, set in JS so no two likes spray identically.
			// Written straight onto the <i> elements as custom properties, which is
			// what the supplied keyframes read.
			const dots = host.querySelectorAll<HTMLElement>("i");
			const specs = burstParticles();
			dots.forEach((dot, i) => {
				const spec = specs[i % specs.length];
				if (!spec) {
					return;
				}
				dot.style.setProperty("--px", spec.px);
				dot.style.setProperty("--py", spec.py);
				dot.style.setProperty("--pdur", spec.pdur);
				dot.style.setProperty("--pdelay", spec.pdelay);
				dot.style.setProperty("--p-end-scale", spec.pEndScale);
				dot.style.setProperty("--psize", spec.psize);
			});
		}
		setBursting(true);
		if (burstTimer.current) {
			clearTimeout(burstTimer.current);
		}
		// REMOVE the class after the burst. Without this a second like re-runs
		// nothing, because the class never changed.
		burstTimer.current = setTimeout(() => setBursting(false), BURST_MAX_MS);
	}, []);

	if (!(like.available && namespace)) {
		return null;
	}

	const label = like.liked
		? `Unlike (${formatLikeCount(like.count)})`
		: `Like (${formatLikeCount(like.count)})`;

	return (
		<button
			aria-label={label}
			aria-pressed={like.liked}
			className={cn(
				// `relative` is supplied HERE rather than in the stylesheet so that
				// block stays byte-identical to the source CSS; the particle layer is
				// absolutely positioned and needs a containing block.
				"t-like relative inline-flex items-center gap-1 bg-transparent p-0 text-muted-foreground text-xs leading-none",
				// The ONLY hover affordance: the glyph warms toward the like colour.
				// No background, no border, no pill.
				"transition-colors hover:text-foreground",
				like.liked && "text-(--like-color)",
				// Added on a like and REMOVED after BURST_MAX_MS — see `fire`.
				bursting && "is-bursting",
				className
			)}
			data-liked={like.liked ? "true" : "false"}
			data-testid="item-like-button"
			onClick={(event) => {
				if (stopPropagation) {
					event.stopPropagation();
					event.preventDefault();
				}
				// Burst only when a like is actually about to HAPPEN.
				//   - not on the unlike half: confetti for a removal reads as a
				//     second like;
				//   - not when the caller has no session: `toggle` will bounce them
				//     to a sign-in prompt instead of liking anything, and spraying
				//     eight particles over a heart that stays empty and a count that
				//     does not move is celebrating an action that did not occur.
				if (!(like.liked || like.needsAuth)) {
					fire();
				}
				like.toggle();
			}}
			type="button"
		>
			{/* The wrapper that carries the pop. Never move the animation onto the
			    <svg> — see the header note. */}
			<span className="t-like-icon inline-flex">
				<svg
					aria-hidden="true"
					className="t-like-heart size-3.5"
					fill="none"
					focusable="false"
					viewBox="0 0 24 24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M12 20.25c-.3 0-.6-.11-.83-.32C7.14 16.2 4.5 13.79 4.5 10.6 4.5 8.2 6.35 6.4 8.7 6.4c1.33 0 2.6.62 3.3 1.6.7-.98 1.97-1.6 3.3-1.6 2.35 0 4.2 1.8 4.2 4.2 0 3.19-2.64 5.6-6.67 9.33-.23.21-.53.32-.83.32Z"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="1.6"
					/>
				</svg>
			</span>
			<span className="t-like-particles" ref={particlesRef}>
				{/* Eight empty dots; every visual property comes from the sheet and
				    the per-particle custom properties `fire` writes. */}
				{PARTICLE_KEYS.map((key) => (
					<i key={key} />
				))}
			</span>
			{/* Content is the heart plus the number. No "Like" label, by design. */}
			<span className="tabular-nums">
				{like.loading ? "" : formatLikeCount(like.count)}
			</span>
		</button>
	);
}

/** How long `.is-bursting` stays on. Re-exported for the e2e story, which
 *  asserts the class is added AND removed — a present-only check passes on the
 *  exact bug the note in the CSS warns about. */
export { BURST_MAX_MS };
