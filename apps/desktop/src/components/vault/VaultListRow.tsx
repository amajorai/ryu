// One row of a vault admin list: a title line, a muted detail line and
// trailing actions, matching the Syncs tab rows.

import type { ReactNode } from "react";

export function VaultListRow({
	actions,
	detail,
	title,
}: {
	actions?: ReactNode;
	detail: ReactNode;
	title: ReactNode;
}) {
	return (
		<li className="flex items-center justify-between gap-4 px-4 py-3">
			<div className="min-w-0">
				<p className="flex flex-wrap items-center gap-2 text-sm">{title}</p>
				<p className="mt-0.5 truncate text-muted-foreground text-xs">
					{detail}
				</p>
			</div>
			{actions ? (
				<div className="flex shrink-0 items-center gap-1">{actions}</div>
			) : null}
		</li>
	);
}
