"use client";

// packages/ui/src/components/status-badge.tsx
//
// The ONE status attribute chip: Active · Unavailable · Built-in · Default.
//
// Those four words were rendered as TEXT in seventeen places across four
// packages, in three different visual treatments — a `<Badge variant="secondary">`
// here, a bare string inside a disabled `<Button>` there, a `string[]` entry in a
// hero's badge row somewhere else. On a two-column grid of listing rows that is a
// wall of grey words repeating what the row's own controls already say, and it is
// the single thing that made the Store read as busy.
//
// A glyph with the word on hover says the same thing in a quarter of the width.
// The pattern is not new here: `verified-badge.tsx` in @ryu/marketplace has been
// the icon-plus-tooltip chip for the publisher check since it shipped, and every
// structural decision below is copied from it deliberately.
//
// WHY IT LIVES IN @ryu/ui. The call sites span packages/marketplace,
// packages/blocks, apps/desktop and apps/web. `@ryu/ui/components/tooltip.tsx` is
// the only module all four already import — marketplace explicitly refuses to
// import blocks source (see `skill-list-row.tsx`'s header), so neither of those
// packages could have owned it.
//
// WHY THE TRIGGER IS A <span role="img">, NEVER A <button>. Two independent
// reasons, both live:
//   • `StoreCatalogCard` wraps every row in a stretched `absolute inset-0`
//     <button>, and `SkillListRow` IS a <button>. A nested button is invalid HTML
//     that browsers "repair" by dropping the inner one — the control vanishes with
//     no type error and no failing build.
//   • `TooltipContent` is portaled, so `renderToStaticMarkup` never emits it. The
//     `aria-label` is therefore the ONLY thing a static-markup test (or a screen
//     reader walking the card's accessible name) can see. It carries the label, so
//     replacing text with a glyph loses nothing to assistive tech.
//
// The provider is self-contained rather than assumed: this renders on both hosts
// and web mounts no global TooltipProvider. Nesting one inside an existing
// provider is harmless.

import {
	CheckmarkCircle02Icon,
	ChipIcon,
	StarCircleIcon,
	UnavailableIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "../lib/utils.ts";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip.tsx";

/** Chip geometry, matching `BASE_CHIP` in the marketplace's catalog-badges so a
 *  status glyph lines up with the token/size badges it sits beside. */
const BASE_CHIP =
	"inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-3xl px-1.5 py-0.5 font-medium type-caption whitespace-nowrap";

/** The four attributes a catalog row, a library row or a sidebar row can carry. */
export type StatusKind = "active" | "builtin" | "default" | "unavailable";

/**
 * Glyph + default label + tone per attribute.
 *
 * Glyph choices are constrained by what is already spoken for in this repo, and
 * an "obvious" pick is wrong in three of the four cases:
 *   • `CheckmarkCircle02Icon` is ALREADY the repo's green check (the Add button's
 *     "Added" state paints it `text-status-success`), so Active inherits a mark the user
 *     has already learned.
 *   • `ChipIcon` — not `CpuIcon`, which is the Engines section's own glyph in 35
 *     places, and not `LockedIcon`, which the agent editor already uses for a
 *     DIFFERENT badge ("Locked") on the very same line as its "Built-in" one.
 *   • `StarCircleIcon` — not `StarIcon`, which is the Library's favourite star and
 *     the Store's rating mark.
 *   • `UnavailableIcon` is already the "signature invalid" mark on two surfaces,
 *     which is the same "you cannot have this" reading.
 */
const STATUS_META = {
	active: {
		icon: CheckmarkCircle02Icon,
		label: "Active",
		tone: "bg-success/12 text-status-success",
	},
	builtin: {
		icon: ChipIcon,
		label: "Built in",
		tone: "bg-foreground/8 text-foreground/80",
	},
	default: {
		icon: StarCircleIcon,
		label: "Default",
		tone: "bg-foreground/8 text-foreground/80",
	},
	unavailable: {
		icon: UnavailableIcon,
		label: "Unavailable",
		tone: "bg-destructive/12 text-status-destructive",
	},
} satisfies Record<
	StatusKind,
	{ icon: IconSvgElement; label: string; tone: string }
>;

/** The label a given status shows on hover, before any caller override. */
export function statusLabel(kind: StatusKind): string {
	return STATUS_META[kind].label;
}

/**
 * One status attribute as an icon with its word on hover.
 *
 * `label` overrides the default — use it whenever the surface knows something
 * more specific than the bare attribute, which for "unavailable" is almost
 * always ("Unavailable on this platform", "Needs macOS 14 or newer"). A glyph
 * whose tooltip only repeats the glyph's own generic meaning is a downgrade from
 * the text it replaced; a glyph whose tooltip says WHY is an upgrade.
 */
export function StatusBadge({
	kind,
	label,
	tone = "card",
	className,
}: {
	className?: string;
	kind: StatusKind;
	/** Overrides the hover text AND the accessible name. Say why, not what. */
	label?: string;
	/** `"card"` sits on the page background and gets the themed tint. `"hero"`
	 *  sits on a listing hero's author-supplied dither wash under a black scrim,
	 *  where every foreground is fixed white and a themed tint is illegible — it
	 *  gets the hero's own translucent chip treatment instead. */
	tone?: "card" | "hero";
}) {
	const meta = STATUS_META[kind];
	const text = label ?? meta.label;
	return (
		<TooltipProvider delay={0}>
			<Tooltip>
				<TooltipTrigger
					render={
						<span
							aria-label={text}
							className={cn(
								BASE_CHIP,
								tone === "hero"
									? "bg-white/15 text-white/90 backdrop-blur-sm"
									: meta.tone,
								className
							)}
							role="img"
						>
							<HugeiconsIcon className="size-3" icon={meta.icon} />
						</span>
					}
				/>
				<TooltipContent>{text}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * The class an UNAVAILABLE row wears.
 *
 * A listing you cannot install is not hidden — hiding it answers "why is X
 * missing?" with silence, and the platform-support answer is exactly what the
 * user needs. It is dimmed instead, with the reason on the row's status glyph.
 *
 * Exported as a constant rather than baked into each card so the three card
 * components (`StoreCatalogCard`, `AgentBadgeCard`, the Library card) dim by the
 * same amount; three hand-typed opacities drift.
 */
export const UNAVAILABLE_ROW_CLASS = "opacity-50";

export default StatusBadge;
