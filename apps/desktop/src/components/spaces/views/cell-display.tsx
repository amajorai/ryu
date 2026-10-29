import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { DataGridOptionBadge } from "@ryu/ui/components/data-grid/data-grid-option-badge.tsx";
import { isFormulaError } from "@ryu/ui/lib/data-grid-formula.ts";
import {
	isNativeBoolean,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CellOpts, CellSelectOption } from "@ryu/ui/types/data-grid.ts";
import { Check, ExternalLink } from "lucide-react";
import type { DbColumn } from "@/src/lib/realtime/yjs-database.ts";

/** Resolve a select option (by value) to its label + color for display. */
function findOption<TValue>(
	options: CellSelectOption[],
	value: TValue
): CellSelectOption | undefined {
	return options.find((option) => option.value === value);
}

/** A single colored select/multi-select tag. */
function OptionTag({ option }: { option: CellSelectOption }) {
	return (
		<DataGridOptionBadge color={option.color}>
			{option.label}
		</DataGridOptionBadge>
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
		const href = safeHttpUrl(isNativeText(value) ? value : null);
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
				<span className="truncate" title={href}>
					{href}
				</span>
			</a>
		);
	}

	const text =
		value == null
			? ""
			: isNativeBoolean(value)
				? String(value).toUpperCase()
				: String(value);
	if (!text) {
		return null;
	}
	return (
		<span
			className={cn(
				"text-foreground/80 text-sm",
				cell.variant === "formula" &&
					isFormulaError(value) &&
					"text-destructive"
			)}
		>
			{text}
		</span>
	);
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
			<span
				className="w-20 shrink-0 truncate text-muted-foreground text-xs"
				title={column.label}
			>
				{column.label}
			</span>
			<div className="min-w-0 flex-1">
				<CellValue column={column} value={value} />
			</div>
		</div>
	);
}
