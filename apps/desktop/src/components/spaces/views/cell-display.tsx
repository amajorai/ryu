import { Badge } from "@ryu/ui/components/badge";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid";
import { cn } from "@ryu/ui/lib/utils";
import type { CellOpts, CellSelectOption } from "@ryu/ui/types/data-grid";
import { Check, ExternalLink } from "lucide-react";
import type { DbColumn } from "@/src/lib/realtime/yjs-database.ts";

/** Resolve a select option (by value) to its label + color for display. */
function findOption(
	options: CellSelectOption[],
	value: unknown
): CellSelectOption | undefined {
	return options.find((option) => option.value === value);
}

/** A single colored select/multi-select tag. */
function OptionTag({ option }: { option: CellSelectOption }) {
	return (
		<Badge
			className={cn(
				"border-transparent font-normal",
				getOptionColorClass(option.color)
			)}
			variant="secondary"
		>
			{option.label}
		</Badge>
	);
}

/**
 * Render one cell value read-only, styled per its column type. Shared by the
 * board, gallery, and list views so a value looks the same wherever it appears.
 * Editing happens in the table view or the row page, never here.
 */
export function CellValue({
	column,
	value,
}: {
	column: DbColumn;
	value: unknown;
}) {
	const cell: CellOpts = column.cell;

	if (cell.variant === "checkbox") {
		return value ? (
			<Check className="size-4 text-muted-foreground" />
		) : (
			<span className="text-muted-foreground/50 text-xs">—</span>
		);
	}

	if (cell.variant === "select") {
		const option = findOption(cell.options, value);
		return option ? <OptionTag option={option} /> : null;
	}

	if (cell.variant === "multi-select") {
		const values = Array.isArray(value) ? value : [];
		if (values.length === 0) {
			return null;
		}
		return (
			<div className="flex flex-wrap gap-1">
				{values.map((v) => {
					const option = findOption(cell.options, v);
					return option ? (
						<OptionTag key={option.value} option={option} />
					) : null;
				})}
			</div>
		);
	}

	if (cell.variant === "url") {
		const href = typeof value === "string" ? value : "";
		if (!href) {
			return null;
		}
		return (
			<a
				className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
				href={href}
				onClick={(e) => e.stopPropagation()}
				rel="noopener noreferrer"
				target="_blank"
			>
				<ExternalLink className="size-3" />
				<span className="truncate">{href}</span>
			</a>
		);
	}

	const text = value == null ? "" : String(value);
	if (!text) {
		return null;
	}
	return <span className="text-foreground/80 text-sm">{text}</span>;
}

/** A labelled property row (label + value) for cards and list items. */
export function PropertyLine({
	column,
	value,
}: {
	column: DbColumn;
	value: unknown;
}) {
	return (
		<div className="flex items-start gap-2 text-sm">
			<span className="w-20 shrink-0 truncate text-muted-foreground text-xs">
				{column.label}
			</span>
			<div className="min-w-0 flex-1">
				<CellValue column={column} value={value} />
			</div>
		</div>
	);
}
