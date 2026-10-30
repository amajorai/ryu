import { cn } from "@ryu/ui/lib/utils.ts";
import type { TabGroupColor } from "@/src/contexts/TabsContext.tsx";
import layoutStyles from "./TitleBar.module.css";

// Radio value used for the "follow the default node" choice in the per-tab node
// picker, distinct from any real node name.
export const DEFAULT_NODE_VALUE = "__default__";

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The vertical bar drawn in the gap beside the hovered tab when the strip cannot
// preview the landing spot by sliding tabs apart (a drop into another bracket).
// The host element must be `relative`.
export function DropIndicator({ side }: { side: "left" | "right" }) {
	return (
		<span
			aria-hidden
			className={cn(
				cn(
					"reorder-drop-indicator pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-primary duration-150",
					layoutStyles.authored1,
					layoutStyles.authored2,
					layoutStyles.authored3
				),
				side === "left" ? "-left-1" : "-right-1"
			)}
		/>
	);
}

// Static Tailwind classes per group color. Kept literal (not interpolated) so
// the compiler actually emits these utilities.
export const GROUP_COLOR_CLASSES = {
	grey: {
		dot: "bg-slate-500",
		pill: "bg-slate-500/20 text-slate-700 dark:text-slate-200",
		container: "bg-slate-500/10 ring-slate-500/25",
	},
	blue: {
		dot: "bg-info",
		pill: "bg-info/20 text-status-info dark:text-status-info",
		container: "bg-info/10 ring-info/25",
	},
	red: {
		dot: "bg-destructive",
		pill: "bg-destructive/20 text-status-destructive dark:text-status-destructive",
		container: "bg-destructive/10 ring-destructive/25",
	},
	yellow: {
		dot: "bg-warning",
		pill: "bg-warning/20 text-status-warning dark:text-status-warning",
		container: "bg-warning/10 ring-warning/25",
	},
	green: {
		dot: "bg-success",
		pill: "bg-success/20 text-status-success dark:text-status-success",
		container: "bg-success/10 ring-success/25",
	},
	pink: {
		dot: "bg-pink-500",
		pill: "bg-pink-500/20 text-pink-700 dark:text-pink-200",
		container: "bg-pink-500/10 ring-pink-500/25",
	},
	purple: {
		dot: "bg-purple-500",
		pill: "bg-purple-500/20 text-purple-700 dark:text-purple-200",
		container: "bg-purple-500/10 ring-purple-500/25",
	},
	cyan: {
		dot: "bg-cyan-500",
		pill: "bg-cyan-500/20 text-cyan-700 dark:text-cyan-200",
		container: "bg-cyan-500/10 ring-cyan-500/25",
	},
	orange: {
		dot: "bg-orange-500",
		pill: "bg-orange-500/20 text-orange-700 dark:text-orange-200",
		container: "bg-orange-500/10 ring-orange-500/25",
	},
} satisfies Record<
	TabGroupColor,
	{ dot: string; pill: string; container: string }
>;

export const COLOR_LABELS = {
	grey: "Grey",
	blue: "Blue",
	red: "Red",
	yellow: "Yellow",
	green: "Green",
	pink: "Pink",
	purple: "Purple",
	cyan: "Cyan",
	orange: "Orange",
} satisfies Record<TabGroupColor, string>;
