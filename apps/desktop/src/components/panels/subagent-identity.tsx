import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	type PanelIconPresentation,
	panelIconPresentationClasses,
} from "@ryu/ui/components/icon.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

// Deterministic, offline avatar identity for subagents (Task/Agent spawns).
// Human-facing names come from each spawn's task description; the opaque id is
// used only to keep the avatar stable across streaming updates and reloads.
//
// We render the identicon locally (a GitHub-style symmetric pixel grid, the
// same visual language as DiceBear's "identicon" style) instead of fetching
// from an external avatar service. Ryu is local-first / no-telemetry by design
// (see AGENTS.md), so leaking subagent ids to a remote host every render — and
// risking the Tauri webview CSP blocking it — is the wrong trade. A pure
// generator gives the same look with zero network dependency.

/** Standard 32-bit string hash (matches `lib/agent-badge.ts`). Stable + cheap. */
function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		// standard 32-bit string hash
		hash = (Math.imul(hash, 31) + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/**
 * A deterministic identicon avatar (5×5 mirrored pixel grid). Pure and offline;
 * the same `seed` always yields the same glyph and hue. Each left-half cell is
 * decided by its own hash of the seed, so the pattern is well distributed
 * without needing a stateful PRNG.
 */
export function Identicon({
	seed,
	className,
}: {
	className?: string;
	seed: string;
}) {
	const hue = hashString(seed) % 360;
	const fill = `hsl(${hue} 58% 55%)`;

	const cells: ReactNode[] = [];
	// Only the left three columns are decided; columns 3–4 mirror 1–0 so the
	// glyph is vertically symmetric, the identicon convention.
	for (let col = 0; col < 3; col++) {
		for (let row = 0; row < 5; row++) {
			if (hashString(`${seed}:${col}:${row}`) % 2 === 0) {
				cells.push(
					<rect
						fill={fill}
						height={1}
						key={`${col}-${row}`}
						width={1}
						x={col}
						y={row}
					/>
				);
				if (col < 2) {
					cells.push(
						<rect
							fill={fill}
							height={1}
							key={`m-${col}-${row}`}
							width={1}
							x={4 - col}
							y={row}
						/>
					);
				}
			}
		}
	}

	return (
		<svg
			aria-hidden="true"
			className={className}
			shapeRendering="crispEdges"
			viewBox="0 0 5 5"
			xmlns="http://www.w3.org/2000/svg"
		>
			{cells}
		</svg>
	);
}

/**
 * A circular avatar tile wrapping the generative dither glyph on a muted
 * backdrop. Round, not a rounded square: every other dither surface in the app
 * (the user menu, the chat's assistant/user avatars) clips its canvas to a
 * circle via `AvatarFallback`, and `DitherAvatar` itself applies no radius — the
 * caller is what clips it — so a squared subagent tile made this rail the only
 * odd one out. `overflow-hidden` is what does the clipping; keep it.
 */
export function SubagentAvatar({
	seed,
	className,
	presentation,
	animate = true,
}: {
	/** Pass `false` where the avatar remounts constantly (a dock tab strip
	 *  re-renders on every tab change): `DitherAvatar` replays a 600ms RAF
	 *  entrance on each mount, which reads as flicker rather than as polish. */
	animate?: boolean;
	className?: string;
	presentation?: PanelIconPresentation;
	seed: string;
}) {
	return (
		// `cn()` and not a raw template string, so a caller-passed radius or
		// position actually overrides rather than colliding with ours (the dock tab
		// strip passes `absolute size-3`).
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted",
				panelIconPresentationClasses(presentation),
				className
			)}
		>
			{/* Dither Kit's generative avatar replaces the local 5x5 identicon: same
			    deterministic-from-seed contract, far more variation (~1.5T combos),
			    and it matches the dithered placeholders used for users/orgs/teams.
			    The local `Identicon` stays exported for any caller that wants the
			    flat SVG (no canvas). */}
			<DitherAvatar animate={animate} className="size-full" name={seed} />
		</span>
	);
}
