// apps/desktop/src/components/chat/DiffReviewPane-file-summary-row.tsx
//
// Per-file summary row for the run diff review pane.

import { FileCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { DiffFilePreviewPopover } from "@/src/components/diffs/RichPatchDiff.tsx";
import type { FileSummary } from "@/src/lib/api/git.ts";

// ── Per-file summary row ──────────────────────────────────────────────────────

export function FileSummaryRow({
	file,
	patch,
	selected,
	onSelect,
}: {
	file: FileSummary;
	patch: string;
	onSelect: () => void;
	selected: boolean;
}) {
	const filename = file.path.split("/").at(-1) ?? file.path;
	const kindLabel =
		file.kind === "added"
			? "A"
			: file.kind === "deleted"
				? "D"
				: file.kind === "renamed"
					? "R"
					: "M";
	const kindClass =
		file.kind === "added"
			? "text-status-success"
			: file.kind === "deleted"
				? "text-status-destructive"
				: "text-muted-foreground";

	const row = (
		<button
			className={cn(
				"flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors duration-150 hover:bg-muted hover:duration-0",
				selected && "bg-muted text-foreground"
			)}
			onClick={onSelect}
			type="button"
		>
			<span className={`w-3 shrink-0 font-medium font-mono ${kindClass}`}>
				{kindLabel}
			</span>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0 text-muted-foreground"
				icon={FileCodeIcon}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<span className="truncate font-mono text-foreground">
							{filename}
						</span>
					}
				/>
				<TooltipContent>{file.path}</TooltipContent>
			</Tooltip>
			{(file.additions > 0 || file.deletions > 0) && (
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
					{file.additions > 0 && (
						<span className="text-status-success">
							+{formatCount(file.additions)}
						</span>
					)}
					{file.deletions > 0 && (
						<span className="text-status-destructive">
							-{formatCount(file.deletions)}
						</span>
					)}
				</span>
			)}
		</button>
	);
	return patch ? (
		<DiffFilePreviewPopover filePath={file.path} patch={patch}>
			{row}
		</DiffFilePreviewPopover>
	) : (
		row
	);
}
