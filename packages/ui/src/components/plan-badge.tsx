import { cn } from "@ryu/ui/lib/utils.ts";

/**
 * Subscription or pricing tier a {@link PlanBadge} can render. Billing-backed
 * values mirror the `PlanId` union exported by `@ryu/auth`, and `enterprise`
 * covers the sales-contact pricing card before it exists as a checkout plan.
 * The type is re-declared here rather than imported to keep `@ryu/ui` free of
 * an `@ryu/auth` dependency.
 */
export type PlanTier =
	| "pro"
	| "max"
	| "teams"
	| "enterprise"
	| "desktop-license";

/** Visual definition for one tier: gradient, on-gradient text colour, label. */
interface TierStyle {
	/** CSS `background-image` — a slanted linear-gradient. */
	readonly gradient: string;
	/** Text colour chosen for AA contrast on this gradient. */
	readonly ink: string;
	/** Short, all-caps label shown in the badge. */
	readonly label: string;
}

const TIER_STYLES: Record<PlanTier, TierStyle> = {
	// The signature holographic pastel — near-white, so it needs dark ink.
	pro: {
		label: "Pro",
		ink: "#0b0b14",
		gradient:
			"linear-gradient(15deg,#9effef 0,#d1ffd6 17%,#fff8ad 34%,#a3edff 51%,#bdbdff 68%,#ffb8eb 85%,#ffdda3 100%)",
	},
	// Max sits above Pro: a hotter, jewel-toned sweep (amber → magenta →
	// violet → azure). Deep enough mid-tones to carry light ink.
	max: {
		label: "Max",
		ink: "#0b0b14",
		gradient:
			"linear-gradient(15deg,#c679c4 0%,#fa3d1d 25%,#ffb005 50%,#e1e1fe 75%,#0358f7 100%)",
	},
	// Teams reads "organisation": a confident indigo → blue → cyan.
	teams: {
		label: "Teams",
		ink: "#ffffff",
		gradient:
			"linear-gradient(15deg,#6366f1 0,#3b82f6 42%,#0ea5e9 72%,#22d3ee 100%)",
	},
	// Enterprise is warmer and more grounded than Teams, meant for managed
	// rollouts and governance-heavy deployments.
	enterprise: {
		label: "Enterprise",
		ink: "#ffffff",
		gradient:
			"linear-gradient(15deg,#0f766e 0,#059669 34%,#84cc16 67%,#f59e0b 100%)",
	},
	// The one-time desktop licence: a quiet brushed-steel tone, no shout.
	"desktop-license": {
		label: "Desktop",
		ink: "#10131a",
		gradient: "linear-gradient(15deg,#eef1f5 0,#cdd5e0 50%,#9aa6b8 100%)",
	},
};

/**
 * The tier's gradient (a CSS `background-image` string), exposed for reuse
 * outside the badge — e.g. a matching card border on the pricing page. Reusing
 * this keeps those surfaces in sync with the badge colours automatically.
 */
export function planTierGradient(plan: PlanTier): string {
	return TIER_STYLES[plan].gradient;
}

/**
 * The tier's colours as an ordered ring, for a rotating conic-gradient card
 * border (matching the Pro card's animated border). The linear badge gradient
 * can't be spun around a card, so the border uses these raw stops instead; the
 * first colour is repeated at the end by {@link planTierConicGradient} so the
 * sweep loops seamlessly. Kept beside the badge palette so both stay in sync.
 */
const TIER_BORDER_COLORS: Record<PlanTier, readonly string[]> = {
	pro: [
		"#9effef",
		"#d1ffd6",
		"#fff8ad",
		"#a3edff",
		"#bdbdff",
		"#ffb8eb",
		"#ffdda3",
	],
	max: ["#c679c4", "#fa3d1d", "#ffb005", "#e1e1fe", "#0358f7"],
	teams: ["#6366f1", "#3b82f6", "#0ea5e9", "#22d3ee"],
	enterprise: ["#0f766e", "#059669", "#84cc16", "#f59e0b"],
	"desktop-license": ["#eef1f5", "#cdd5e0", "#9aa6b8"],
};

/**
 * A rotating conic gradient built from the tier's colours, for an animated card
 * border. The angle is driven by `--tier-border-angle` in `globals.css` so the
 * sweep loops seamlessly like the Pro card border.
 */
export function planTierConicGradient(plan: PlanTier): string {
	const colors = TIER_BORDER_COLORS[plan];
	const stops = [...colors, colors[0]].join(",");
	return `conic-gradient(from var(--tier-border-angle),${stops})`;
}

const SIZE_STYLES = {
	sm: "h-[15px] px-1.5 text-[9px]",
	md: "h-[18px] px-2 text-[10px]",
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

const TIER_TITLES: Record<PlanTier, string> = {
	pro: "Ryu Pro",
	max: "Ryu Max",
	teams: "Ryu Teams",
	enterprise: "Ryu Enterprise",
	"desktop-license": "Ryu Desktop",
};

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

	return (
		<span
			className={cn("inline-flex shrink-0 select-none align-middle", className)}
			title={title ?? TIER_TITLES[plan]}
		>
			<span
				className={cn(
					// The slanted plinth: skewed box, gradient fill, soft depth.
					"relative inline-flex items-center justify-center overflow-hidden rounded-[5px]",
					"shadow-[0_1px_2px_rgba(0,0,0,0.18)] ring-1 ring-white/25 ring-inset",
					"-skew-x-12",
					SIZE_STYLES[size]
				)}
				style={{ backgroundImage: style.gradient, color: style.ink }}
			>
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
				<span className="relative skew-x-12 font-extrabold italic leading-none tracking-wide">
					{text}
				</span>
			</span>
		</span>
	);
}
