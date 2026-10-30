import type {
	Split,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";

// Static Tailwind classes per group color. Kept literal (not interpolated) so
// the compiler actually emits these utilities. The colour is identity data and
// shows only as a 6px dot; pills and brackets stay neutral (no tinted boxes).
export const GROUP_COLOR_CLASSES = {
	grey: {
		dot: "bg-slate-500",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	blue: {
		dot: "bg-info",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	red: {
		dot: "bg-destructive",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	yellow: {
		dot: "bg-warning",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	green: {
		dot: "bg-success",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	pink: {
		dot: "bg-pink-500",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	purple: {
		dot: "bg-purple-500",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	cyan: {
		dot: "bg-cyan-500",
		pill: "bg-muted text-foreground",
		container: "ring-border",
	},
	orange: {
		dot: "bg-orange-500",
		pill: "bg-muted text-foreground",
		container: "ring-border",
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

// A contiguous run of unpinned tabs: a single ungrouped tab, a group bracket, or
// a split bracket — each with its members.
export type Segment =
	| { type: "tab"; tab: Tab }
	| { type: "group"; group: TabGroup; members: Tab[] }
	| { type: "split"; split: Split; members: Tab[] };

// legacy component
export function buildSegments(
	unpinned: Tab[],
	groups: TabGroup[],
	splits: Split[]
): Segment[] {
	const segments: Segment[] = [];
	let i = 0;
	while (i < unpinned.length) {
		const tab = unpinned[i];
		if (tab.groupId) {
			const group = groups.find((g) => g.id === tab.groupId);
			const members: Tab[] = [];
			while (i < unpinned.length && unpinned[i].groupId === tab.groupId) {
				members.push(unpinned[i]);
				i += 1;
			}
			if (group) {
				segments.push({ type: "group", group, members });
			} else {
				for (const m of members) {
					segments.push({ type: "tab", tab: m });
				}
			}
		} else if (tab.splitId) {
			const split = splits.find((s) => s.id === tab.splitId);
			const members: Tab[] = [];
			while (i < unpinned.length && unpinned[i].splitId === tab.splitId) {
				members.push(unpinned[i]);
				i += 1;
			}
			if (split) {
				segments.push({ type: "split", split, members });
			} else {
				for (const m of members) {
					segments.push({ type: "tab", tab: m });
				}
			}
		} else {
			segments.push({ type: "tab", tab });
			i += 1;
		}
	}
	return segments;
}
