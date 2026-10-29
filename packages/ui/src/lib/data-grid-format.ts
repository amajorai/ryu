// Conditional formatting for data-grid cells: evaluate a column's highlight
// rules against a cell value and return the palette color to tint it with.

import { isCellValueEmpty } from "@ryu/ui/lib/data-grid-fill.ts";
import {
	isNativeBoolean,
	isNativeNumber,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type {
	CellFormatOperator,
	CellFormatRule,
	CellOpts,
} from "@ryu/ui/types/data-grid.ts";

/** Operators offered for a column type (comparisons only where they make sense). */
export function getFormatOperators(
	variant: CellOpts["variant"] | undefined
): CellFormatOperator[] {
	switch (variant) {
		case "checkbox":
			return ["isNotEmpty", "isEmpty"];
		case "number":
		case "date":
		case "formula":
			return [
				"equals",
				"notEquals",
				"greaterThan",
				"greaterThanOrEqual",
				"lessThan",
				"lessThanOrEqual",
				"isEmpty",
				"isNotEmpty",
				...(variant === "formula"
					? (["contains", "notContains"] as const)
					: []),
			];
		case "select":
			return ["equals", "notEquals", "isEmpty", "isNotEmpty"];
		case "multi-select":
			return ["contains", "notContains", "isEmpty", "isNotEmpty"];
		default:
			return [
				"contains",
				"notContains",
				"equals",
				"notEquals",
				"isEmpty",
				"isNotEmpty",
			];
	}
}

export const FORMAT_OPERATOR_LABELS = {
	isEmpty: "Is empty",
	isNotEmpty: "Is not empty",
	equals: "Is",
	notEquals: "Is not",
	contains: "Contains",
	notContains: "Does not contain",
	greaterThan: "Greater than",
	greaterThanOrEqual: "At least",
	lessThan: "Less than",
	lessThanOrEqual: "At most",
} satisfies Record<CellFormatOperator, string>;

/** Whether an operator compares against a typed-in value. */
export function formatOperatorTakesValue(
	operator: CellFormatOperator
): boolean {
	return operator !== "isEmpty" && operator !== "isNotEmpty";
}

/** The comparable strings a cell shows: option labels for selects, else the text. */
function cellTexts<CellValue>(value: CellValue, cellOpts?: CellOpts): string[] {
	const items = Array.isArray(value) ? value : [value];
	return items.map((item) => {
		if (
			cellOpts?.variant === "select" ||
			cellOpts?.variant === "multi-select"
		) {
			const option = cellOpts.options.find((o) => o.value === item);
			return (option?.label ?? String(item ?? "")).toLowerCase();
		}
		if (item instanceof Date) {
			return item.toISOString().slice(0, 10);
		}
		return String(item ?? "").toLowerCase();
	});
}

function compareValues<CellValue>(
	rawValue: CellValue,
	target: string
): number | null {
	// Pasted dates arrive as Date objects; compare them as the ISO day they show.
	const value =
		rawValue instanceof Date ? rawValue.toISOString().slice(0, 10) : rawValue;
	const left = isNativeNumber(value) ? value : Number(value);
	const right = Number(target);
	if (
		!isNativeBoolean(value) &&
		target.trim() !== "" &&
		!Number.isNaN(left) &&
		!Number.isNaN(right)
	) {
		return left - right;
	}
	// Dates (ISO strings) and text compare lexically.
	const text = String(value ?? "").toLowerCase();
	const other = target.toLowerCase();
	if (!text) {
		return null;
	}
	if (text === other) {
		return 0;
	}
	return text < other ? -1 : 1;
}

export function matchesFormatRule<CellValue>(
	value: CellValue,
	rule: CellFormatRule,
	cellOpts?: CellOpts
): boolean {
	const empty = isCellValueEmpty(value);
	const target = (rule.value ?? "").trim();
	switch (rule.operator) {
		case "isEmpty":
			return empty;
		case "isNotEmpty":
			return !empty;
		case "contains":
		case "notContains": {
			const found = cellTexts(value, cellOpts).some((text) =>
				text.includes(target.toLowerCase())
			);
			return rule.operator === "contains" ? !empty && found : !found;
		}
		case "equals":
		case "notEquals": {
			// Blank cells match only the "Is empty" operators.
			if (empty) {
				return false;
			}
			const equal =
				cellOpts?.variant === "select"
					? cellTexts(value, cellOpts)[0] === target.toLowerCase()
					: compareValues(value, target) === 0;
			return rule.operator === "equals" ? equal : !equal;
		}
		default: {
			if (empty) {
				return false;
			}
			const difference = compareValues(value, target);
			if (difference === null) {
				return false;
			}
			switch (rule.operator) {
				case "greaterThan":
					return difference > 0;
				case "greaterThanOrEqual":
					return difference >= 0;
				case "lessThan":
					return difference < 0;
				default:
					return difference <= 0;
			}
		}
	}
}

/** The color of the first rule `value` matches, if any. */
export function getCellFormatColor<CellValue>(
	value: CellValue,
	cellOpts?: CellOpts
): string | undefined {
	return cellOpts?.formatRules?.find((rule) =>
		matchesFormatRule(value, rule, cellOpts)
	)?.color;
}
