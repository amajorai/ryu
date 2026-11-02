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

// One cluster of unpinned tabs: a single ungrouped tab, a group bracket, or a
// split bracket — each with its members.
export type Segment =
	| { type: "tab"; tab: Tab }
	| { type: "group"; group: TabGroup; members: Tab[] }
	| { type: "split"; split: Split; members: Tab[] };

// legacy component
// Each group or split is one segment, placed at its first member, even when the
// tab order interleaves it with other tabs: the Workbench projection lists a
// Center split's members group by group, so a split's second pane can follow
// tabs that are not in it. Emitting one bracket per contiguous run instead gave
// two segments with the same split id (and React key) and a split shown twice.
export function buildSegments(
	unpinned: Tab[],
	groups: TabGroup[],
	splits: Split[]
): Segment[] {
	const clusterOf = (
		tab: Tab
	):
		| { key: string; type: "group"; group: TabGroup }
		| { key: string; type: "split"; split: Split }
		| undefined => {
		const group = tab.groupId
			? groups.find((g) => g.id === tab.groupId)
			: undefined;
		if (group) {
			return { key: `g:${group.id}`, type: "group", group };
		}
		// A tab whose group is gone renders on its own, as it always has.
		const split =
			!tab.groupId && tab.splitId
				? splits.find((s) => s.id === tab.splitId)
				: undefined;
		return split ? { key: `s:${split.id}`, type: "split", split } : undefined;
	};
	const segments: Segment[] = [];
	const emitted = new Set<string>();
	for (const tab of unpinned) {
		const cluster = clusterOf(tab);
		if (!cluster) {
			segments.push({ type: "tab", tab });
			continue;
		}
		if (emitted.has(cluster.key)) {
			continue;
		}
		emitted.add(cluster.key);
		const members = unpinned.filter((m) => clusterOf(m)?.key === cluster.key);
		segments.push(
			cluster.type === "group"
				? { type: "group", group: cluster.group, members }
				: { type: "split", split: cluster.split, members }
		);
	}
	return segments;
}
