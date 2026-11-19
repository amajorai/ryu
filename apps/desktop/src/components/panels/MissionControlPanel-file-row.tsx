import { useOptionalI18n } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { MissionFileTouch } from "@/src/lib/mission-control/turn-groups.ts";

// What the turn did to a file (created, edited, read). Each label reads
// through its own sense id: the bare words are the create, edit and read verbs.
const TOUCH_META = {
	create: {
		className: "text-status-success",
		label: "new",
		sense: "missionControl.touchNew",
	},
	edit: {
		className: "text-status-warning",
		label: "edit",
		sense: "missionControl.touchEdit",
	},
	read: {
		className: "text-muted-foreground",
		label: "read",
		sense: "missionControl.touchRead",
	},
} satisfies Record<
	MissionFileTouch["kind"],
	{ className: string; label: string; sense: string }
>;

/** One file a turn touched: what it did, the path and the repeat count. */
export function FileRow({ touch }: { touch: MissionFileTouch }) {
	const meta = TOUCH_META[touch.kind];
	const label = useOptionalI18n()?.t(meta.sense, {}, meta.label) ?? meta.label;
	return (
		<div className="flex items-center gap-2 py-0.5">
			<span className={cn("w-8 shrink-0 text-xs", meta.className)}>
				{label}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs" title={touch.path}>
				{touch.path}
			</span>
			{touch.count > 1 && (
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					×{formatCount(touch.count) ?? String(touch.count)}
				</span>
			)}
		</div>
	);
}
