import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	getOptionColorClass,
	SELECT_OPTION_COLOR_KEYS,
} from "@ryu/ui/lib/data-grid.ts";
import {
	FORMAT_OPERATOR_LABELS,
	formatOperatorTakesValue,
	getFormatOperators,
} from "@ryu/ui/lib/data-grid-format.ts";
import {
	compileFormula,
	FORMULA_FUNCTION_NAMES,
} from "@ryu/ui/lib/data-grid-formula.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	CellFormatOperator,
	CellFormatRule,
	CellOpts,
} from "@ryu/ui/types/data-grid.ts";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

/** The column types offered in the editor (file is deferred — needs uploads). */
const COLUMN_TYPE_OPTIONS: Array<{
	variant: CellOpts["variant"];
	label: string;
}> = [
	{ variant: "short-text", label: "Text" },
	{ variant: "long-text", label: "Long text" },
	{ variant: "number", label: "Number" },
	{ variant: "select", label: "Select" },
	{ variant: "multi-select", label: "Multi-select" },
	{ variant: "checkbox", label: "Checkbox" },
	{ variant: "date", label: "Date" },
	{ variant: "url", label: "URL" },
	{ variant: "formula", label: "Formula" },
];

const OPTION_VARIANTS = new Set<CellOpts["variant"]>([
	"select",
	"multi-select",
]);

interface OptionDraft {
	color: string;
	label: string;
	value: string;
}

function newOptionValue(): string {
	return `opt_${crypto.randomUUID().slice(0, 8)}`;
}

function initialOptions(cell?: CellOpts): OptionDraft[] {
	if (cell && (cell.variant === "select" || cell.variant === "multi-select")) {
		return cell.options.map((option) => ({
			value: option.value,
			label: option.label,
			color: option.color ?? SELECT_OPTION_COLOR_KEYS[0] ?? "gray",
		}));
	}
	return [];
}

function newRuleId(): string {
	return `rule_${crypto.randomUUID().slice(0, 8)}`;
}

function variantCell(
	variant: CellOpts["variant"],
	options: OptionDraft[],
	expression: string
): CellOpts {
	if (variant === "formula") {
		return { variant: "formula", expression: expression.trim() };
	}
	if (variant === "select" || variant === "multi-select") {
		return {
			variant,
			options: options
				.filter((option) => option.label.trim())
				.map((option) => ({
					value: option.value,
					label: option.label.trim(),
					color: option.color,
				})),
		};
	}
	if (variant === "number") {
		return { variant: "number" };
	}
	if (variant === "file") {
		return { variant: "file" };
	}
	return { variant };
}

function draftToCell(
	variant: CellOpts["variant"],
	options: OptionDraft[],
	expression: string,
	rules: CellFormatRule[]
): CellOpts {
	const cell = variantCell(variant, options, expression);
	const operators = new Set(getFormatOperators(variant));
	const formatRules = rules.filter(
		(rule) =>
			operators.has(rule.operator) &&
			(!formatOperatorTakesValue(rule.operator) || rule.value?.trim())
	);
	return formatRules.length > 0 ? { ...cell, formatRules } : cell;
}

/** Live feedback for a formula draft: an error, or the columns it uses. */
function FormulaStatus({
	expression,
	columns,
}: {
	expression: string;
	columns: Array<{ id: string; label: string }>;
}) {
	const status = useMemo(() => {
		if (!expression.trim()) {
			return null;
		}
		const result = compileFormula(expression);
		if (!result.ok) {
			return { error: result.message };
		}
		const known = new Set(
			columns.flatMap((column) => [
				column.label.trim().toLowerCase(),
				column.id.toLowerCase(),
			])
		);
		const missing = result.formula.references.filter(
			(name) => !known.has(name.trim().toLowerCase())
		);
		return missing.length > 0
			? { error: `No column named ${missing.join(", ")}` }
			: { ok: true };
	}, [expression, columns]);

	if (!status) {
		return null;
	}
	return (
		<p
			className={cn(
				"text-xs",
				"error" in status ? "text-destructive" : "text-muted-foreground"
			)}
		>
			{"error" in status ? status.error : "Formula is valid"}
		</p>
	);
}

/**
 * A Notion-style column (property) editor used for both creating and editing a
 * database column: name, type, and — for select / multi-select — a list of
 * options with colored tags. The parent renders this inside a `Dialog` and
 * persists the result via `addColumn` (create) or `updateColumn` (edit).
 */
export function ColumnEditor({
	initial,
	columns = [],
	submitLabel,
	onSubmit,
	onCancel,
}: {
	initial?: { label: string; cell: CellOpts };
	/** The database's other columns, for formula references. */
	columns?: Array<{ id: string; label: string }>;
	submitLabel: string;
	onSubmit: (label: string, cell: CellOpts) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(initial?.label ?? "");
	const [variant, setVariant] = useState<CellOpts["variant"]>(
		initial?.cell.variant ?? "short-text"
	);
	const [options, setOptions] = useState<OptionDraft[]>(() =>
		initialOptions(initial?.cell)
	);
	const [expression, setExpression] = useState(
		initial?.cell.variant === "formula" ? initial.cell.expression : ""
	);
	const [rules, setRules] = useState<CellFormatRule[]>(
		() => initial?.cell.formatRules ?? []
	);
	const operators = getFormatOperators(variant);

	const addRule = () =>
		setRules((prev) => [
			...prev,
			{
				id: newRuleId(),
				operator: operators[0] ?? "isNotEmpty",
				value: "",
				color: "red",
			},
		]);

	const updateRule = (id: string, patch: Partial<CellFormatRule>) =>
		setRules((prev) =>
			prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
		);

	const removeRule = (id: string) =>
		setRules((prev) => prev.filter((rule) => rule.id !== id));

	const formulaInvalid =
		variant === "formula" && !compileFormula(expression).ok;

	const addOption = () =>
		setOptions((prev) => [
			...prev,
			{
				value: newOptionValue(),
				label: `Option ${prev.length + 1}`,
				color:
					SELECT_OPTION_COLOR_KEYS[
						prev.length % SELECT_OPTION_COLOR_KEYS.length
					] ?? "gray",
			},
		]);

	const setOptionLabel = (value: string, next: string) =>
		setOptions((prev) =>
			prev.map((option) =>
				option.value === value ? { ...option, label: next } : option
			)
		);

	const setOptionColor = (value: string, color: string) =>
		setOptions((prev) =>
			prev.map((option) =>
				option.value === value ? { ...option, color } : option
			)
		);

	const removeOption = (value: string) =>
		setOptions((prev) => prev.filter((option) => option.value !== value));

	const submit = () =>
		onSubmit(
			label.trim() || "Untitled",
			draftToCell(variant, options, expression, rules)
		);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<span className="font-medium text-sm">Name</span>
				<Input
					aria-label="Name"
					autoFocus
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Property name"
					value={label}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<span className="font-medium text-sm">Type</span>
				<div className="grid grid-cols-2 gap-1">
					{COLUMN_TYPE_OPTIONS.map((type) => (
						<Button
							className="justify-start"
							key={type.variant}
							onClick={() => setVariant(type.variant)}
							size="sm"
							variant={variant === type.variant ? "secondary" : "ghost"}
						>
							{type.label}
						</Button>
					))}
				</div>
			</div>

			{OPTION_VARIANTS.has(variant) && (
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-sm">Options</span>
					<div className="flex flex-col gap-1">
						{options.map((option) => (
							<div className="flex items-center gap-1.5" key={option.value}>
								<Popover>
									<PopoverTrigger
										render={
											<button
												aria-label="Option color"
												className={cn(
													"size-6 shrink-0 rounded-md border",
													getOptionColorClass(option.color)
												)}
												type="button"
											/>
										}
									/>
									<PopoverContent
										align="start"
										className="w-auto"
										spacing="choice-grid"
									>
										<div className="grid grid-cols-5 gap-1">
											{SELECT_OPTION_COLOR_KEYS.map((color) => (
												<button
													aria-label={color}
													className={cn(
														"size-6 rounded-md border",
														getOptionColorClass(color),
														option.color === color && "ring-2 ring-ring"
													)}
													key={color}
													onClick={() => setOptionColor(option.value, color)}
													type="button"
												/>
											))}
										</div>
									</PopoverContent>
								</Popover>
								<Input
									aria-label="Option label"
									className="h-8"
									onChange={(e) => setOptionLabel(option.value, e.target.value)}
									placeholder="Option"
									value={option.label}
								/>
								<Button
									aria-label="Remove option"
									onClick={() => removeOption(option.value)}
									size="icon"
									variant="ghost"
								>
									<X className="size-4" />
								</Button>
							</div>
						))}
						<Button
							className="justify-start"
							onClick={addOption}
							size="sm"
							variant="ghost-muted"
						>
							<Plus className="size-3.5" />
							Add option
						</Button>
					</div>
				</div>
			)}

			{variant === "formula" && (
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-sm">Formula</span>
					<Input
						aria-label="Formula"
						onChange={(e) => setExpression(e.target.value)}
						placeholder="{Price} * {Quantity}"
						value={expression}
						variant="code"
					/>
					<FormulaStatus columns={columns} expression={expression} />
					{columns.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{columns.map((column) => (
								<Button
									key={column.id}
									onClick={() =>
										setExpression((prev) => `${prev}{${column.label}}`)
									}
									size="tiny"
									variant="outline"
								>
									{column.label}
								</Button>
							))}
						</div>
					)}
					<p className="text-muted-foreground text-xs">
						Reference columns as {"{Column name}"}. Use + - * / ^, & to join
						text, comparisons, and {FORMULA_FUNCTION_NAMES.join(", ")}.
					</p>
				</div>
			)}

			{variant !== "file" && (
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-sm">Conditional formatting</span>
					{rules.map((rule) => (
						<div className="flex items-center gap-1.5" key={rule.id}>
							<NativeSelect
								aria-label="Condition"
								className="w-36 shrink-0"
								onChange={(e) =>
									updateRule(rule.id, {
										// SAFETY: the options below are exactly the operators
										// getFormatOperators returned for this column type.
										operator: e.target.value as CellFormatOperator,
									})
								}
								size="sm"
								value={rule.operator}
							>
								{operators.map((operator) => (
									<NativeSelectOption key={operator} value={operator}>
										{FORMAT_OPERATOR_LABELS[operator]}
									</NativeSelectOption>
								))}
							</NativeSelect>
							{formatOperatorTakesValue(rule.operator) ? (
								<Input
									aria-label="Value"
									className="h-8"
									onChange={(e) =>
										updateRule(rule.id, { value: e.target.value })
									}
									placeholder={variant === "date" ? "YYYY-MM-DD" : "Value"}
									value={rule.value ?? ""}
								/>
							) : (
								<span className="flex-1" />
							)}
							<Popover>
								<PopoverTrigger
									render={
										<button
											aria-label="Highlight color"
											className={cn(
												"size-6 shrink-0 rounded-md border",
												getOptionColorClass(rule.color)
											)}
											type="button"
										/>
									}
								/>
								<PopoverContent
									align="end"
									className="w-auto"
									spacing="choice-grid"
								>
									<div className="grid grid-cols-5 gap-1">
										{SELECT_OPTION_COLOR_KEYS.map((color) => (
											<button
												aria-label={color}
												className={cn(
													"size-6 rounded-md border",
													getOptionColorClass(color),
													rule.color === color && "ring-2 ring-ring"
												)}
												key={color}
												onClick={() => updateRule(rule.id, { color })}
												type="button"
											/>
										))}
									</div>
								</PopoverContent>
							</Popover>
							<Button
								aria-label="Remove rule"
								onClick={() => removeRule(rule.id)}
								size="icon"
								variant="ghost"
							>
								<X className="size-4" />
							</Button>
						</div>
					))}
					<Button
						className="justify-start"
						onClick={addRule}
						size="sm"
						variant="ghost-muted"
					>
						<Plus className="size-3.5" />
						Add highlight rule
					</Button>
					{rules.length > 0 && (
						<p className="text-muted-foreground text-xs">
							The first matching rule colors the cell in the table view.
						</p>
					)}
				</div>
			)}

			<div className="flex justify-end gap-2">
				<Button onClick={onCancel} size="sm" variant="ghost">
					Cancel
				</Button>
				<Button disabled={formulaInvalid} onClick={submit} size="sm">
					{submitLabel}
				</Button>
			</div>
		</div>
	);
}
