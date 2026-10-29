import { Badge } from "@ryu/ui/components/badge.tsx";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid.ts";
import type { ReactNode } from "react";

/**
 * A select / multi-select option tag in its persisted palette color: the same
 * pill the data grid draws. An unset or unknown color keeps the neutral
 * secondary fill. Read-only surfaces outside the grid (board group headers,
 * gallery and list cells) render options through this so the tint stays on the
 * Badge itself rather than on a wrapper that cannot match its rounded shape.
 */
export function DataGridOptionBadge({
	children,
	color,
}: {
	children: ReactNode;
	color?: string;
}) {
	return (
		<Badge
			className={getOptionColorClass(color)}
			typography="normal"
			variant="secondary"
		>
			{children}
		</Badge>
	);
}
