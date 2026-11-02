import { translate as tl } from "@ryu/i18n/lite";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import {
	DECIMAL_TEXT_REGEX,
	FORMULA_ERRORS,
	FORMULA_MAX_TEXT_LENGTH,
	FormulaFailure,
	type FormulaValue,
	INFINITY_TEXT_REGEX,
	ISO_DAY_REGEX,
	MS_PER_DAY,
	type Node,
} from "./data-grid-formula-syntax.ts";

// The evaluation half of the data grid formula language (see
// `data-grid-formula.ts`): value coercion and the fixed function set.

/** Turn a cell value into a formula value (lists join, dates stay ISO strings). */
const formulaInputSchema = z.unknown().transform((value) => {
	if (value === null || value === undefined) {
		return null;
	}
	if (isNativeNumber(value) || isNativeText(value) || isNativeBoolean(value)) {
		return value;
	}
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}
	if (Array.isArray(value)) {
		return value
			.map((item) =>
				item && isNativeObjectLike(item) && "name" in item
					? String(item.name)
					: String(item)
			)
			.join(", ");
	}
	return String(value);
});

export const formulaRowInputSchema = z.record(z.string(), z.unknown());

export function toFormulaValue<Input>(value: Input): FormulaValue {
	return formulaInputSchema.parse(value);
}

export function toNumber(value: FormulaValue): number {
	if (value === null || value === "") {
		return 0;
	}
	if (isNativeBoolean(value)) {
		return value ? 1 : 0;
	}
	if (isNativeNumber(value)) {
		return value;
	}
	const trimmed = value.trim();
	const parsed =
		DECIMAL_TEXT_REGEX.test(trimmed) || INFINITY_TEXT_REGEX.test(trimmed)
			? Number(trimmed)
			: Number.NaN;
	if (Number.isNaN(parsed)) {
		throw new FormulaFailure(
			FORMULA_ERRORS.value,
			`"${value}" is not a number`
		);
	}
	return parsed;
}

function toText(value: FormulaValue): string {
	if (value === null) {
		return "";
	}
	if (isNativeBoolean(value)) {
		return value ? "TRUE" : "FALSE";
	}
	return String(value);
}

/** Text results are capped so chained concatenation cannot grow without bound. */
function boundedText(text: string): string {
	if (text.length > FORMULA_MAX_TEXT_LENGTH) {
		throw new FormulaFailure(FORMULA_ERRORS.value, "Text result is too long");
	}
	return text;
}

/** Concatenate, refusing before allocating a result over the text limit. */
function concatText(parts: string[]): string {
	let length = 0;
	for (const part of parts) {
		length += part.length;
		if (length > FORMULA_MAX_TEXT_LENGTH) {
			throw new FormulaFailure(FORMULA_ERRORS.value, "Text result is too long");
		}
	}
	return parts.join("");
}

function toBoolean(value: FormulaValue): boolean {
	if (isNativeBoolean(value)) {
		return value;
	}
	if (isNativeNumber(value)) {
		return value !== 0;
	}
	if (value === null || value === "") {
		return false;
	}
	const upper = value.toUpperCase();
	if (upper === "TRUE" || upper === "FALSE") {
		return upper === "TRUE";
	}
	throw new FormulaFailure(
		FORMULA_ERRORS.value,
		`"${value}" is not TRUE or FALSE`
	);
}

function toDayNumber(value: FormulaValue): number {
	if (isNativeNumber(value)) {
		return value;
	}
	const match = isNativeText(value) ? ISO_DAY_REGEX.exec(value) : null;
	if (!match) {
		throw new FormulaFailure(
			FORMULA_ERRORS.value,
			"Expected a date (YYYY-MM-DD)"
		);
	}
	return (
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
		MS_PER_DAY
	);
}

function compare(left: FormulaValue, right: FormulaValue): number {
	const bothNumeric =
		(isNativeNumber(left) || isNativeBoolean(left)) &&
		(isNativeNumber(right) || isNativeBoolean(right));
	if (bothNumeric) {
		return toNumber(left) - toNumber(right);
	}
	const a = toText(left).toLowerCase();
	const b = toText(right).toLowerCase();
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

function roundResult(value: number): number {
	return Math.round(value * 1e10) / 1e10;
}

export type Evaluate = (node: Node) => FormulaValue;

function numbersOf(args: Node[], evaluate: Evaluate): number[] {
	return args
		.map(evaluate)
		.filter((value) => value !== null && value !== "")
		.map(toNumber);
}

function expectArgs(name: string, args: Node[], min: number, max = min) {
	if (args.length < min || args.length > max) {
		throw new FormulaFailure(
			FORMULA_ERRORS.value,
			min === max
				? tl(
						"{name} takes {count, plural, one {# argument} other {# arguments}}",
						{
							count: min,
							name,
						}
					)
				: tl("{name} takes {min}–{max} arguments", { max, min, name })
		);
	}
}

export const FUNCTIONS = new Map<
	string,
	(args: Node[], evaluate: Evaluate) => FormulaValue
>([
	[
		"IF",
		(args, evaluate) => {
			expectArgs("IF", args, 2, 3);
			const [condition, whenTrue, whenFalse] = args;
			if (!(condition && whenTrue)) {
				return null;
			}
			if (toBoolean(evaluate(condition))) {
				return evaluate(whenTrue);
			}
			return whenFalse ? evaluate(whenFalse) : false;
		},
	],
	["AND", (args, evaluate) => args.every((arg) => toBoolean(evaluate(arg)))],
	["OR", (args, evaluate) => args.some((arg) => toBoolean(evaluate(arg)))],
	[
		"NOT",
		(args, evaluate) => {
			expectArgs("NOT", args, 1);
			return args[0] ? !toBoolean(evaluate(args[0])) : null;
		},
	],
	[
		"SUM",
		(args, evaluate) =>
			roundResult(numbersOf(args, evaluate).reduce((a, b) => a + b, 0)),
	],
	[
		"AVERAGE",
		(args, evaluate) => {
			const numbers = numbersOf(args, evaluate);
			if (numbers.length === 0) {
				throw new FormulaFailure(
					FORMULA_ERRORS.divZero,
					"AVERAGE of no values"
				);
			}
			return roundResult(numbers.reduce((a, b) => a + b, 0) / numbers.length);
		},
	],
	[
		"MIN",
		(args, evaluate) => {
			const numbers = numbersOf(args, evaluate);
			return numbers.length > 0 ? Math.min(...numbers) : null;
		},
	],
	[
		"MAX",
		(args, evaluate) => {
			const numbers = numbersOf(args, evaluate);
			return numbers.length > 0 ? Math.max(...numbers) : null;
		},
	],
	[
		"ROUND",
		(args, evaluate) => {
			expectArgs("ROUND", args, 1, 2);
			const value = toNumber(args[0] ? evaluate(args[0]) : null);
			const digits = args[1] ? toNumber(evaluate(args[1])) : 0;
			const factor = 10 ** Math.trunc(digits);
			return Math.round(value * factor) / factor;
		},
	],
	[
		"ABS",
		(args, evaluate) => {
			expectArgs("ABS", args, 1);
			return Math.abs(toNumber(args[0] ? evaluate(args[0]) : null));
		},
	],
	[
		"CONCAT",
		(args, evaluate) => concatText(args.map((arg) => toText(evaluate(arg)))),
	],
	[
		"LEN",
		(args, evaluate) => {
			expectArgs("LEN", args, 1);
			return toText(args[0] ? evaluate(args[0]) : null).length;
		},
	],
	[
		"UPPER",
		(args, evaluate) => {
			expectArgs("UPPER", args, 1);
			return boundedText(
				toText(args[0] ? evaluate(args[0]) : null).toUpperCase()
			);
		},
	],
	[
		"LOWER",
		(args, evaluate) => {
			expectArgs("LOWER", args, 1);
			return boundedText(
				toText(args[0] ? evaluate(args[0]) : null).toLowerCase()
			);
		},
	],
	[
		"TRIM",
		(args, evaluate) => {
			expectArgs("TRIM", args, 1);
			return toText(args[0] ? evaluate(args[0]) : null).trim();
		},
	],
	[
		"CONTAINS",
		(args, evaluate) => {
			expectArgs("CONTAINS", args, 2);
			const [text, part] = args;
			return toText(text ? evaluate(text) : null)
				.toLowerCase()
				.includes(toText(part ? evaluate(part) : null).toLowerCase());
		},
	],
	[
		"ISBLANK",
		(args, evaluate) => {
			expectArgs("ISBLANK", args, 1);
			const value = args[0] ? evaluate(args[0]) : null;
			return value === null || value === "";
		},
	],
	[
		"TODAY",
		(args) => {
			expectArgs("TODAY", args, 0);
			// UTC, so Desktop and a Core node in another timezone agree on the day.
			return new Date().toISOString().slice(0, 10);
		},
	],
	[
		"DAYS",
		(args, evaluate) => {
			expectArgs("DAYS", args, 2);
			const [end, start] = args;
			return (
				toDayNumber(end ? evaluate(end) : null) -
				toDayNumber(start ? evaluate(start) : null)
			);
		},
	],
]);

/** The function names formulas may call, for help text. */
export const FORMULA_FUNCTION_NAMES = Array.from(FUNCTIONS.keys());

export function evaluateBinary(
	op: string,
	left: FormulaValue,
	right: FormulaValue
): FormulaValue {
	switch (op) {
		case "+":
			return roundResult(toNumber(left) + toNumber(right));
		case "-":
			return roundResult(toNumber(left) - toNumber(right));
		case "*":
			return roundResult(toNumber(left) * toNumber(right));
		case "/": {
			const divisor = toNumber(right);
			if (divisor === 0) {
				throw new FormulaFailure(FORMULA_ERRORS.divZero, "Division by zero");
			}
			return roundResult(toNumber(left) / divisor);
		}
		case "^":
			return roundResult(toNumber(left) ** toNumber(right));
		case "&":
			return concatText([toText(left), toText(right)]);
		case "=":
			return compare(left, right) === 0;
		case "<>":
			return compare(left, right) !== 0;
		case "<":
			return compare(left, right) < 0;
		case ">":
			return compare(left, right) > 0;
		case "<=":
			return compare(left, right) <= 0;
		default:
			return compare(left, right) >= 0;
	}
}
