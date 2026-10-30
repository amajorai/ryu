import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { getOptionColorClass } from "@ryu/ui/lib/data-grid.ts";
import { isFormulaError } from "@ryu/ui/lib/data-grid-formula.ts";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CellSelectOption } from "@ryu/ui/types/data-grid.ts";
import { z } from "zod";
import type {
	applyCellEdits,
	DbColumn,
	DbRow,
} from "@/src/lib/realtime/yjs-database.ts";

export const SAVE_DEBOUNCE_MS = 800;

/** Drop the reserved collaborative `__id` before serializing to JSON. */
export function stripRowIds(rows: DbRow[]): DbRow[] {
	return rows.map(({ __id, ...rest }) => rest);
}

/** Colored option pills for a select / multi-select property. */
export function OptionPills({
	options,
	selected,
	onToggle,
	readOnly,
}: {
	options: CellSelectOption[];
	selected: Set<string>;
	onToggle: (value: string) => void;
	readOnly: boolean;
}) {
	return (
		<div className="flex flex-wrap gap-1">
			{options.map((option) => {
				const isSelected = selected.has(option.value);
				return (
					<button
						aria-pressed={isSelected}
						className={cn(
							"rounded-full px-2 py-0.5 text-xs",
							isSelected
								? getOptionColorClass(option.color) || "bg-secondary"
								: "border text-muted-foreground hover:bg-accent"
						)}
						disabled={readOnly}
						key={option.value}
						onClick={() => onToggle(option.value)}
						type="button"
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

/** One editable property field, dispatched by the column's cell type. */
export function PropertyField({
	column,
	value,
	readOnly,
	onChange,
}: {
	column: DbColumn;
	value: unknown;
	readOnly: boolean;
	onChange: (
		value: Parameters<typeof applyCellEdits>[1][number]["value"]
	) => void;
}) {
	const { cell } = column;
	if (cell.variant === "formula") {
		return (
			<span
				className={cn(
					"block pt-1.5 text-sm",
					isFormulaError(value) && "text-destructive"
				)}
			>
				{isNativeBoolean(value)
					? String(value).toUpperCase()
					: String(value ?? "")}
			</span>
		);
	}
	if (cell.variant === "checkbox") {
		return (
			<Checkbox
				aria-label={column.label}
				checked={value === true}
				disabled={readOnly}
				onCheckedChange={(checked) => onChange(checked === true)}
			/>
		);
	}
	if (cell.variant === "long-text") {
		return (
			<Textarea
				aria-label={column.label}
				className="min-h-16"
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value)}
				value={isNativeText(value) ? value : ""}
			/>
		);
	}
	if (cell.variant === "number") {
		return (
			<Input
				aria-label={column.label}
				disabled={readOnly}
				onChange={(e) =>
					onChange(e.target.value === "" ? null : Number(e.target.value))
				}
				type="number"
				value={isNativeNumber(value) ? String(value) : ""}
			/>
		);
	}
	if (cell.variant === "date") {
		return (
			<Input
				aria-label={column.label}
				disabled={readOnly}
				onChange={(e) => onChange(e.target.value || null)}
				type="date"
				value={isNativeText(value) ? value.slice(0, 10) : ""}
			/>
		);
	}
	if (cell.variant === "select") {
		const current = isNativeText(value) ? value : null;
		return (
			<OptionPills
				onToggle={(v) => onChange(current === v ? null : v)}
				options={cell.options}
				readOnly={readOnly}
				selected={new Set(current ? [current] : [])}
			/>
		);
	}
	if (cell.variant === "multi-select") {
		const current = z.array(z.string()).catch([]).parse(value);
		return (
			<OptionPills
				onToggle={(v) =>
					onChange(
						current.includes(v)
							? current.filter((x) => x !== v)
							: [...current, v]
					)
				}
				options={cell.options}
				readOnly={readOnly}
				selected={new Set(current)}
			/>
		);
	}
	// short-text / url / fallback
	return (
		<Input
			aria-label={column.label}
			disabled={readOnly}
			onChange={(e) => onChange(e.target.value)}
			type={cell.variant === "url" ? "url" : "text"}
			value={isNativeText(value) ? value : ""}
		/>
	);
}
