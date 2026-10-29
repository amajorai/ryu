// apps/desktop/src/components/downloads/DownloadTypeBadge.tsx
//
// The small type pill on a download row ("Chat model", "Engine", "Unpacking").
// Sits in TrayRow's `trailing` slot, which is the right-aligned stamp on the
// title line — so the type is always in the same place on every row instead of
// being smuggled into the name as a parenthetical on the rows that happened to
// have one.
//
// The explanation is a native `title` rather than a Tooltip: DownloadRow already
// decided against tooltips inside the row (nesting another trigger made the whole
// row a tooltip target), and the badge is a passive stamp, not a control.

import { Badge } from "@ryu/ui/components/badge.tsx";
import type { DownloadBadge } from "@/src/lib/catalog/downloadBadge.ts";

// Muted fills rather than solid ones: the row's own title, progress bar and
// controls are the things to read first — the type is orienting, not shouting.
// Badge's `tint` variant carries exactly the BadgeTone keys, so the fill stays
// on the pill itself.
export function DownloadTypeBadge({ badge }: { badge: DownloadBadge }) {
	return (
		<Badge
			size="download-label"
			tint={badge.tone}
			title={badge.tooltip}
			variant="secondary"
		>
			{badge.label}
		</Badge>
	);
}
