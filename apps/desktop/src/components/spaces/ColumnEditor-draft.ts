import { SELECT_OPTION_COLOR_KEYS } from "@ryu/ui/lib/data-grid.ts";
import {
	formatOperatorTakesValue,
	getFormatOperators,
} from "@ryu/ui/lib/data-grid-format.ts";
import type { CellFormatRule, CellOpts } from "@ryu/ui/types/data-grid.ts";

/** The column types offered in the editor (file is deferred — needs uploads). */
export const COLUMN_TYPE_OPTIONS: Array<{
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

export const OPTION_VARIANTS = new Set<CellOpts["variant"]>([
	"select",
	"multi-select",
]);

export interface OptionDraft {
	color: string;
	label: string;
	value: string;
}

export function newOptionValue(): string {
	return `opt_${crypto.randomUUID().slice(0, 8)}`;
}

export function initialOptions(cell?: CellOpts): OptionDraft[] {
	if (cell && (cell.variant === "select" || cell.variant === "multi-select")) {
		return cell.options.map((option) => ({
			value: option.value,
			label: option.label,
			color: option.color ?? SELECT_OPTION_COLOR_KEYS[0] ?? "gray",
		}));
	}
	return [];
}

export function newRuleId(): string {
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

export function draftToCell(
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
