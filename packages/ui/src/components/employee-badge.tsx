"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { Logo } from "./logo.tsx";
import { PassCardShell } from "./pass-card-shell.tsx";

/**
 * The agent's employee badge — the same physical card object the waitlist pass
 * is, with an agent's details on the front instead of a member's.
 *
 * It shares `PassCardShell`, so it is genuinely the same card: the metal ring
 * (see {@link EmployeeBadgeProps.ringed} — a grid turns it off), the generative
 * dither backdrop seeded from the agent's name, real thickness, the slow float,
 * the pointer tilt, and drag-to-turn with the Ryu mark on the back. Only the
 * front-face content is written here.
 *
 * It used to be a flat bordered panel with a lanyard notch that merely evoked an
 * ID card. Reusing the shell rather than restyling this one to match is the
 * whole point — a copy would drift the moment either card changed.
 *
 * Colour comes from design tokens so it reads in light and dark.
 */

export interface EmployeeStat {
	label: string;
	value: string;
}

export interface EmployeeBadgeProps {
	/**
	 * Accepted but unused: the card leads with the agent's NAME, and a *portrait*
	 * competed with it — the same call the waitlist pass made. A brand mark is a
	 * different object and does have a home here; that is {@link logo}. Kept on
	 * the interface so existing call sites keep type-checking.
	 */
	avatarUrl?: string;
	className?: string;
	employeeId: string;
	hiredAt?: string;
	/**
	 * Omit where there is no level to show. A catalog listing has never worked a
	 * day, and printing "Lv 0" on every card in a grid states a fact nobody asked
	 * for — the badge id alone is the right header there.
	 */
	level?: number;
	/**
	 * The agent's own brand mark (Claude, Codex, Cursor …), drawn large directly
	 * above the name. It belongs on the card face rather than in a caller's footer
	 * strip: these marks are how the agent is recognised, long before the name is
	 * read, and a 20px glyph under the card read as a stray annotation. Sized by
	 * the caller — the block reserves the room and does not scale it.
	 */
	logo?: ReactNode;
	/**
	 * Which tuning of the metal ring to paint; pass the app's resolved theme.
	 * Still read with {@link ringed} off — it also colours the milled edge and
	 * decides which face the shader would be lit for.
	 */
	metalTheme?: "auto" | "dark" | "light";
	name: string;
	onClick?: () => void;
	/**
	 * Paint the animated metal ring around the card. Defaults on for the one hero
	 * badge on a settings page; a GRID passes `false`. The geometry does not move
	 * either way (see `PassCardShell`'s `CardRingFrame`) — off simply drops the
	 * `metal-fx` WebGL instance, which is both the visual noise of twenty
	 * shimmering rings on one screen and twenty live shader instances behind it.
	 */
	ringed?: boolean;
	role?: string;
	stats?: EmployeeStat[];
	/**
	 * Freeze the card's self-motion for a grid — see {@link PassCardShell}'s
	 * `still`. Hover still tilts and glares; the badge simply stops turning and
	 * floating on its own, because twenty of those on one screen is a fault
	 * rather than a flourish.
	 */
	still?: boolean;
}

const NON_ALPHANUMERIC = /[^a-zA-Z0-9]/g;
const SHORT_ID_LENGTH = 6;
/** How many stats fit across the footer before it starts to crowd. */
const MAX_FOOTER_STATS = 3;

/**
 * A stable, human-readable badge id like "A1B2C3" from an agent id. No "EMP-"
 * prefix any more: the card already says Ryu on the line above it.
 */
export const formatEmployeeId = (employeeId: string): string => {
	const compact = employeeId.replace(NON_ALPHANUMERIC, "").toUpperCase();
	return (compact || "000000")
		.slice(0, SHORT_ID_LENGTH)
		.padEnd(SHORT_ID_LENGTH, "0");
};

/** Format a hire date as "Jan 5, 2026, 07:30 PM"; null for missing/invalid input. */
const formatHiredAt = (hiredAt: string | undefined): string | null => {
	if (!hiredAt) {
		return null;
	}
	const date = new Date(hiredAt);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return `${date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	})}, ${date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
};

export function EmployeeBadge({
	className,
	employeeId,
	hiredAt,
	level,
	logo,
	metalTheme = "auto",
	name,
	onClick,
	ringed = true,
	role,
	stats,
	still = false,
}: EmployeeBadgeProps) {
	const hiredLabel = formatHiredAt(hiredAt);
	const badgeId = formatEmployeeId(employeeId);
	// Level sits in the header, not in the footer row. Prepending it there pushed
	// a caller-supplied stat off the end of the slice — a silent data loss, since
	// both call sites pass exactly three.
	const footerStats = (stats ?? []).slice(0, MAX_FOOTER_STATS);

	return (
		<PassCardShell
			className={cn(onClick && "cursor-pointer", className)}
			ditherSeed={name || employeeId}
			metalTheme={metalTheme}
			ringed={ringed}
			still={still}
		>
			{/* `min-h` rather than a fixed height: the name is the hero and can wrap
			    to two or three lines, so the card grows past the floor instead of
			    clipping. The hero block takes the slack (`flex-1`), which is what
			    keeps a short name from leaving the footer floating in the middle. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the shell owns the
			    pointer gestures, so the click target has to be this inner surface. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: as above — a nested
			    button would swallow the shell's drag-to-turn. */}
			<div
				className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7"
				onClick={onClick}
			>
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2">
						<Logo size="20px" variant="outline" />
						<span className="font-medium text-sm">Ryu</span>
					</span>
					<span className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
						{level === undefined ? null : <span>Lv {level}</span>}
						<span>{badgeId}</span>
					</span>
				</div>

				<div className="flex min-w-0 flex-1 flex-col justify-end gap-1.5">
					{/* Bottom-anchored with the name (`justify-end` above), so the mark
					    sits directly on top of it and a long name pushes the pair up
					    rather than clipping the logo. */}
					{logo ? (
						<span className="mb-3 flex items-center [&_img]:object-contain">
							{logo}
						</span>
					) : null}
					<span className="break-words font-medium text-5xl leading-[1.02] tracking-tight">
						{name}
					</span>
					{role ? (
						<span className="truncate text-base text-muted-foreground">
							{role}
						</span>
					) : null}
				</div>

				{/* Value above its label, sentence case: the number is the fact worth
				    reading and the word only says which fact it is. */}
				<div className="flex items-start justify-between gap-4">
					{footerStats.map((stat) => (
						<div className="flex flex-col" key={stat.label}>
							<span className="font-medium text-xl tabular-nums leading-none">
								{stat.value}
							</span>
							<span className="text-muted-foreground text-xs">
								{stat.label}
							</span>
						</div>
					))}
				</div>

				{hiredLabel ? (
					<span className="text-[11px] text-muted-foreground tabular-nums">
						Hired {hiredLabel}
					</span>
				) : null}
			</div>
		</PassCardShell>
	);
}
