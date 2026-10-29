import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import drawingStyles from "./plan-badge.drawing.module.css";

interface BadgeInkStyle extends CSSProperties {
	"--plan-badge-1-color"?: CSSProperties["color"];
}
interface BadgeGradientStyle extends CSSProperties {
	"--plan-badge-2-background-image"?: CSSProperties["backgroundImage"];
}

/**
 * Subscription or pricing tier a {@link PlanBadge} can render. Billing-backed
 * values mirror the `PlanId` union exported by `@ryu/auth`, and `enterprise`
 * covers the sales-contact pricing card before it exists as a checkout plan.
 * The type is re-declared here rather than imported to keep `@ryu/ui` free of
 * an `@ryu/auth` dependency.
 */
export type PlanTier =
	| "marketplace-membership"
	| "plus"
	| "pro"
	| "max"
	| "teams"
	| "teams-lite"
	| "business"
	| "enterprise"
	| "desktop-license";

/**
 * Palette used by pricing-card borders. Gateway PAYG is a standalone offer,
 * not a subscription PlanTier.
 */
export type PlanCardPalette = PlanTier | "gateway-payg";

/** Visual definition for one tier: gradient, on-gradient text colour, label. */
interface TierStyle {
	/** CSS `background-image` used by the tier badge. */
	readonly gradient: string;
	/** Text colour chosen for AA contrast on this gradient. */
	readonly ink: string;
	/** Short, all-caps label shown in the badge. */
	readonly label: string;
}

const TIER_STYLES = {
	// A Major Pass carries the animated violet, rose, and amber gradient.
	"marketplace-membership": {
		label: "A Major Pass",
		ink: "#ffffff",
		gradient:
			"linear-gradient(135deg,#090613 0%,#2b348f 30%,#655be0 52%,#de5c9f 73%,#ff941f 100%)",
	},
	// The signature holographic pastel — near-white, so it needs dark ink.
	pro: {
		label: "Pro",
		ink: "#0b0b14",
		gradient:
			"linear-gradient(15deg,#9effef 0,#d1ffd6 17%,#fff8ad 34%,#a3edff 51%,#bdbdff 68%,#ffb8eb 85%,#ffdda3 100%)",
	},
	plus: {
		label: "Plus",
		ink: "#0b0b14",
		gradient:
			"radial-gradient(87.5139% 80.7298% at 76.8195% 26.8195%,#e2dfd8 0%,#e2dfd8 40%,rgba(226,223,216,0) 90%,rgba(226,223,216,0) 100%),radial-gradient(101.273% 101.273% at 100% 55.2245%,#56faf7 0%,#56faf7 35%,rgba(86,250,247,0) 80%),radial-gradient(160.387% 160.387% at 100% 53.6389%,#a162ff 20%,rgba(145,76,255,0) 75%),radial-gradient(197.349% 197.349% at 100% 53.6389%,#f8dcbb 0%,#f8dcbb 38%,rgba(226,223,216,0) 90%)",
	},
	// Max sits above Pro: a hotter, jewel-toned sweep (amber → magenta →
	// violet → azure). Deep enough mid-tones to carry light ink.
	max: {
		label: "Max",
		ink: "#0b0b14",
		gradient:
			"linear-gradient(15deg,#c679c4 0%,#fa3d1d 25%,#ffb005 50%,#e1e1fe 75%,#0358f7 100%)",
	},
	// Teams keeps the reference gradient saturated through the lightest stop.
	teams: {
		label: "Teams",
		ink: "#ffffff",
		gradient: "linear-gradient(180deg,#031c26 0%,#1b6aa7 43%,#57d2f4 100%)",
	},
	"teams-lite": {
		label: "Teams Lite",
		ink: "#ffffff",
		gradient: "linear-gradient(180deg,#031c26 0%,#1b6aa7 43%,#57d2f4 100%)",
	},
	business: {
		label: "Business",
		ink: "#ffffff",
		gradient:
			"linear-gradient(15deg,#5dffe4 0,#8dff9a 8%,#fff36a 16%,#60dfff 24%,#7b7cff 32%,#ff77d8 40%,#ffc45f 48%,#5dffe4 56%,#8dff9a 64%,#fff36a 72%,#60dfff 80%,#7b7cff 88%,#ff77d8 96%,#ffc45f 100%)",
	},
	// Enterprise uses the original green sweep for managed rollouts and
	// governance-heavy deployments.
	enterprise: {
		label: "Enterprise",
		ink: "#ffffff",
		gradient:
			"linear-gradient(15deg,#0f766e 0,#059669 34%,#84cc16 67%,#f59e0b 100%)",
	},
	// A one-time desktop licence gets the former champagne-gold palette.
	"desktop-license": {
		label: "Desktop",
		ink: "#10131a",
		gradient: "linear-gradient(15deg,#fff1b8 0%,#c8942e 100%)",
	},
} satisfies Record<PlanTier, TierStyle>;

/**
 * The tier's gradient (a CSS `background-image` string), exposed for reuse
 * outside the badge — e.g. a matching card border on the pricing page. Reusing
 * this keeps those surfaces in sync with the badge colours automatically.
 */
export function planTierGradient(plan: PlanTier): string {
	return TIER_STYLES[plan].gradient;
}

/** Text color for an opaque tier gradient, such as a badge or social image. */
export function planTierOpaqueInk(plan: PlanTier): string {
	return TIER_STYLES[plan].ink;
}

/**
 * The tier's short name ("Pro", "Max", …), for surfaces that print the tier as
 * type rather than as a badge — the tier pass sets it as the card's hero.
 *
 * Opaque gradients may pair these colors with `planTierOpaqueInk`. Textured
 * surfaces should keep their own foreground tokens because badge ink assumes
 * a fully opaque background.
 */
export function planTierLabel(plan: PlanTier): string {
	return TIER_STYLES[plan].label;
}

/**
 * The tier's colours as an ordered ring, for a rotating conic-gradient card
 * border (matching the Pro card's animated border). The linear badge gradient
 * can't be spun around a card, so the border uses these raw stops instead; the
 * first colour is repeated at the end by {@link planTierConicGradient} so the
 * sweep loops seamlessly. Kept beside the badge palette so both stay in sync.
 */
const TIER_BORDER_COLORS = {
	"marketplace-membership": [
		"#090613",
		"#2b348f",
		"#655be0",
		"#de5c9f",
		"#ff941f",
	],
	pro: [
		"#9effef",
		"#d1ffd6",
		"#fff8ad",
		"#a3edff",
		"#bdbdff",
		"#ffb8eb",
		"#ffdda3",
	],
	plus: ["#e2dfd8", "#56faf7", "#a162ff", "#f8dcbb"],
	max: ["#c679c4", "#fa3d1d", "#ffb005", "#e1e1fe", "#0358f7"],
	teams: ["#031c26", "#1b6aa7", "#57d2f4"],
	"teams-lite": ["#031c26", "#1b6aa7", "#57d2f4"],
	business: [
		"#5dffe4",
		"#8dff9a",
		"#fff36a",
		"#60dfff",
		"#7b7cff",
		"#ff77d8",
		"#ffc45f",
		"#5dffe4",
		"#8dff9a",
		"#fff36a",
		"#60dfff",
		"#7b7cff",
		"#ff77d8",
		"#ffc45f",
	],
	enterprise: ["#0f766e", "#059669", "#84cc16", "#f59e0b"],
	"desktop-license": ["#fff1b8", "#c8942e"],
} satisfies Record<PlanTier, readonly string[]>;

const GATEWAY_PAYG_BORDER_COLORS = [
	"#1e0b33",
	"#354389",
	"#624c95",
	"#a73455",
	"#f83d34",
	"#f3a316",
] as const;

/**
 * A rotating conic gradient built from the tier's colours, for an animated card
 * border. The angle is driven by `--tier-border-angle` in `globals.css` so the
 * sweep loops seamlessly like the Pro card border.
 */
/**
 * The tier's colours as a flat, ordered stop list — the same stops the badge
 * gradient interpolates, without the `linear-gradient()` wrapper around them.
 *
 * For consumers that need the palette as DATA rather than as CSS: the tier pass
 * feeds these to the warp shader so the card's field IS the badge gradient in
 * motion, and a canvas painter cannot parse a gradient string at all. Returning
 * the stops keeps one source of tier colour instead of a second palette that
 * would drift the first time a tier is retuned.
 */
export function planTierColors(plan: PlanTier): readonly string[] {
	return TIER_BORDER_COLORS[plan];
}

export function planTierConicGradient(plan: PlanTier): string {
	return planCardConicGradient(plan);
}

export function planCardConicGradient(plan: PlanCardPalette): string {
	const colors =
		plan === "gateway-payg"
			? GATEWAY_PAYG_BORDER_COLORS
			: TIER_BORDER_COLORS[plan];
	return conicGradientFromColors(colors);
}

function conicGradientFromColors(colors: readonly string[]): string {
	const stops = [...colors, colors[0]].join(",");
	return `conic-gradient(from var(--tier-border-angle),${stops})`;
}

const SIZE_STYLES = {
	sm: "h-[15px] px-1.5 type-micro",
	md: "h-[18px] px-2 type-compact",
} as const;

export interface PlanBadgeProps {
	/** Outer className (positioning/margins live here, not on the skewed box). */
	className?: string;
	/** Override the label (defaults to the tier's name, e.g. "Pro"). */
	label?: string;
	/** The tier to render. Renders nothing when null/undefined. */
	plan: PlanTier | null | undefined;
	/** Compact (`sm`) for inline-with-name, roomier (`md`) for standalone. */
	size?: keyof typeof SIZE_STYLES;
	/** Accessible/tooltip title; defaults to e.g. "Ryu Pro". */
	title?: string;
}

const TIER_TITLES = {
	"marketplace-membership": "Ryu A Major Pass",
	pro: "Ryu Pro",
	plus: "Ryu Plus",
	max: "Ryu Max",
	teams: "Ryu Teams",
	"teams-lite": "Ryu Teams Lite",
	business: "Ryu Business",
	enterprise: "Ryu Enterprise",
	"desktop-license": "Ryu Desktop",
} satisfies Record<PlanTier, string>;

/**
 * A right-slanted, italic, all-caps, bold gradient badge marking a user's
 * subscription tier. Drop it next to a display name anywhere (sidebar, chat
 * message author, account page). The parallelogram is produced by skewing the
 * box; the glyphs are counter-skewed and italicised so they lean cleanly with
 * the slant instead of doubling up on it.
 *
 * Returns `null` for an absent plan, so call sites can render it
 * unconditionally: `<PlanBadge plan={tier} />`.
 */
export function PlanBadge({
	plan,
	size = "sm",
	className,
	label,
	title,
}: PlanBadgeProps) {
	if (!plan) {
		return null;
	}
	const style = TIER_STYLES[plan];
	const text = (label ?? style.label).toUpperCase();

	const badgeInkStyle: BadgeInkStyle = {
		"--plan-badge-1-color": `var(--plan-tier-${plan}-ink)`,
	};
	const badgeGradientStyle: BadgeGradientStyle = {
		"--plan-badge-2-background-image": `var(--plan-tier-${plan}-gradient)`,
	};
	return (
		<span
			className={cn("inline-flex shrink-0 select-none align-middle", className)}
			title={title ?? TIER_TITLES[plan]}
		>
			<span
				className={cn(
					cn(
						// The slanted plinth: skewed box, gradient fill, soft depth.
						"relative inline-flex items-center justify-center overflow-hidden rounded-[5px]",
						"shadow-[0_1px_2px_rgba(0,0,0,0.18)] ring-1 ring-white/25 ring-inset",
						"-skew-x-12",
						SIZE_STYLES[size]
					),
					drawingStyles.badgeInk
				)}
				style={badgeInkStyle}
			>
				<span
					aria-hidden="true"
					className={cn(
						cn(
							"t-plan-badge-gradient pointer-events-none absolute inset-0",
							plan === "plus" && "t-plan-badge-plus-gradient",
							plan === "business" && "t-plan-badge-business-gradient"
						),
						drawingStyles.badgeGradient
					)}
					style={badgeGradientStyle}
				/>
				{/* A looping diagonal sheen sweeping left to right, holographic. */}
				<span
					aria-hidden="true"
					className="t-plan-badge-sheen pointer-events-none"
				/>
				{/* The same sweep, masked down to just the edge, so the border catches
				 * light in sync with the face. */}
				<span
					aria-hidden="true"
					className="t-plan-badge-border pointer-events-none"
				/>
				<span className="relative skew-x-12 font-medium italic leading-none tracking-wide">
					{text}
				</span>
			</span>
		</span>
	);
}
