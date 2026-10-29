import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

// A small, safe spreadsheet-formula language for database formula columns.
// Expressions reference other columns as `{Column name}` and support
// arithmetic, comparison, `&` concatenation, and a fixed function set.
// Nothing is evaluated as code: input is tokenized, parsed into an AST,
// and interpreted.
//
// Core evaluates the same language for read-only SQL queries in
// `crates/core/spaces/src/database_formula.rs`; keep the two in step.

export type FormulaValue = number | string | boolean | null;

/** Spreadsheet-style error results shown in place of a value. */
export const FORMULA_ERRORS = {
	cycle: "#CYCLE!",
	divZero: "#DIV/0!",
	name: "#NAME?",
	ref: "#REF!",
	syntax: "#ERROR!",
	value: "#VALUE!",
} as const;

export type FormulaError = (typeof FORMULA_ERRORS)[keyof typeof FORMULA_ERRORS];

const ERROR_VALUES = new Set<string>(Object.values(FORMULA_ERRORS));

export function isFormulaError<CellValue>(
	value: CellValue
): value is CellValue & FormulaError {
	return isNativeText(value) && ERROR_VALUES.has(value);
}

/**
 * A referenced formula column's error. Only these propagate as errors: stored
 * text that merely reads like an error code (say "#REF!") stays ordinary text.
 */
export class FormulaErrorValue {
	readonly code: FormulaError;
	constructor(code: FormulaError) {
		this.code = code;
	}
}

class FormulaFailure extends Error {
	readonly code: FormulaError;
	constructor(code: FormulaError, message: string) {
		super(message);
		this.code = code;
	}
}

type Token =
	| { kind: "number"; value: number }
	| { kind: "string"; value: string }
	| { kind: "ref"; name: string }
	| { kind: "ident"; name: string }
	| { kind: "op"; op: string }
	| { kind: "paren"; open: boolean }
	| { kind: "comma" };

const OPERATORS = [
	"<=",
	">=",
	"<>",
	"!=",
	"+",
	"-",
	"*",
	"/",
	"^",
	"&",
	"=",
	"<",
	">",
];
const NUMBER_REGEX = /^\d+(\.\d+)?([eE][+-]?\d+)?/;
// Text coerces to a number only in plain decimal form (no 0x/0b/0o prefixes),
// so Desktop and Core agree on what counts as numeric.
const DECIMAL_TEXT_REGEX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INFINITY_TEXT_REGEX = /^[+-]?Infinity$/;
/** Longest formula, in tokens; longer input is a syntax error. */
export const FORMULA_MAX_TOKENS = 1024;
/** Deepest nesting of parentheses, signs, and calls a formula may use. */
export const FORMULA_MAX_DEPTH = 64;
/** Longest text a formula may produce, in UTF-16 code units (Excel's cell limit). */
export const FORMULA_MAX_TEXT_LENGTH = 32_767;
const IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*/;
const ISO_DAY_REGEX = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_PER_DAY = 86_400_000;

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const rest = source.slice(i);
		const char = source[i] ?? "";
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (char === "{") {
			const end = source.indexOf("}", i + 1);
			if (end === -1) {
				throw new FormulaFailure(
					FORMULA_ERRORS.syntax,
					"Missing } after column name"
				);
			}
			tokens.push({ kind: "ref", name: source.slice(i + 1, end).trim() });
			i = end + 1;
			continue;
		}
		if (char === '"') {
			let value = "";
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === '"' && source[j + 1] === '"') {
					value += '"';
					j += 2;
				} else if (source[j] === '"') {
					break;
				} else {
					value += source[j];
					j++;
				}
			}
			if (j >= source.length) {
				throw new FormulaFailure(
					FORMULA_ERRORS.syntax,
					"Missing closing quote"
				);
			}
			tokens.push({ kind: "string", value });
			i = j + 1;
			continue;
		}
		const number = NUMBER_REGEX.exec(rest);
		if (number) {
			tokens.push({ kind: "number", value: Number(number[0]) });
			i += number[0].length;
			continue;
		}
		const ident = IDENT_REGEX.exec(rest);
		if (ident) {
			tokens.push({ kind: "ident", name: ident[0] });
			i += ident[0].length;
			continue;
		}
		if (char === "(" || char === ")") {
			tokens.push({ kind: "paren", open: char === "(" });
			i++;
			continue;
		}
		if (char === ",") {
			tokens.push({ kind: "comma" });
			i++;
			continue;
		}
		const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
		if (op) {
			tokens.push({ kind: "op", op: op === "!=" ? "<>" : op });
			i += op.length;
			continue;
		}
		throw new FormulaFailure(
			FORMULA_ERRORS.syntax,
			`Unexpected character "${char}"`
		);
	}
	if (tokens.length > FORMULA_MAX_TOKENS) {
		throw new FormulaFailure(FORMULA_ERRORS.syntax, "Formula is too long");
	}
	return tokens;
}

type Node =
	| { kind: "literal"; value: FormulaValue }
	| { kind: "ref"; name: string }
	| { kind: "unary"; op: string; operand: Node }
	| { kind: "binary"; op: string; left: Node; right: Node }
	| { kind: "call"; name: string; args: Node[] };

const BINARY_PRECEDENCE = new Map<string, number>([
	["=", 1],
	["<>", 1],
	["<", 1],
	[">", 1],
	["<=", 1],
	[">=", 1],
	["&", 2],
	["+", 3],
	["-", 3],
	["*", 4],
	["/", 4],
	["^", 5],
]);

function parse(tokens: Token[]): Node {
	let position = 0;
	let depth = 0;
	const peek = () => tokens[position];
	const fail = (message: string): never => {
		throw new FormulaFailure(FORMULA_ERRORS.syntax, message);
	};

	function parsePrimary(): Node {
		const token = tokens[position++];
		if (!token) {
			return fail("Formula ends unexpectedly");
		}
		switch (token.kind) {
			case "number":
				return { kind: "literal", value: token.value };
			case "string":
				return { kind: "literal", value: token.value };
			case "ref":
				return { kind: "ref", name: token.name };
			case "op":
				if (token.op === "-" || token.op === "+") {
					// Like Excel, a sign binds tighter than ^: -2^2 is 4.
					return { kind: "unary", op: token.op, operand: parseExpression(6) };
				}
				return fail(`Unexpected "${token.op}"`);
			case "paren": {
				if (!token.open) {
					return fail('Unexpected ")"');
				}
				const inner = parseExpression(0);
				const close = tokens[position++];
				if (close?.kind !== "paren" || close.open) {
					fail('Missing ")"');
				}
				return inner;
			}
			case "ident": {
				const upper = token.name.toUpperCase();
				const next = peek();
				if (next?.kind === "paren" && next.open) {
					position++;
					const args: Node[] = [];
					const afterOpen = peek();
					if (afterOpen?.kind === "paren" && !afterOpen.open) {
						position++;
						return { kind: "call", name: upper, args };
					}
					for (;;) {
						args.push(parseExpression(0));
						const separator = tokens[position++];
						if (separator?.kind === "comma") {
							continue;
						}
						if (separator?.kind === "paren" && !separator.open) {
							break;
						}
						fail(`Missing ")" after ${upper} arguments`);
					}
					return { kind: "call", name: upper, args };
				}
				if (upper === "TRUE" || upper === "FALSE") {
					return { kind: "literal", value: upper === "TRUE" };
				}
				throw new FormulaFailure(
					FORMULA_ERRORS.name,
					`Unknown name "${token.name}" — wrap column names in {braces}`
				);
			}
			default:
				return fail("Unexpected separator");
		}
	}

	function parseExpression(minPrecedence: number): Node {
		depth++;
		if (depth > FORMULA_MAX_DEPTH) {
			fail("Formula is nested too deeply");
		}
		let left = parsePrimary();
		for (;;) {
			const token = peek();
			if (token?.kind !== "op") {
				break;
			}
			const precedence = BINARY_PRECEDENCE.get(token.op);
			if (precedence === undefined || precedence < minPrecedence) {
				break;
			}
			position++;
			// `^` is right-associative; everything else is left-associative.
			const right = parseExpression(
				token.op === "^" ? precedence : precedence + 1
			);
			left = { kind: "binary", op: token.op, left, right };
		}
		depth--;
		return left;
	}

	const tree = parseExpression(0);
	if (position < tokens.length) {
		fail("Unexpected text after the formula");
	}
	return tree;
}

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

const formulaRowInputSchema = z.record(z.string(), z.unknown());

export function toFormulaValue<Input>(value: Input): FormulaValue {
	return formulaInputSchema.parse(value);
}

function toNumber(value: FormulaValue): number {
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

type Evaluate = (node: Node) => FormulaValue;

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
			`${name} takes ${min === max ? min : `${min}–${max}`} argument${max === 1 ? "" : "s"}`
		);
	}
}

const FUNCTIONS = new Map<
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

function evaluateBinary(
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

export type FormulaResult =
	| { ok: true; value: FormulaValue }
	| { ok: false; code: FormulaError };

export interface CompiledFormula {
	/**
	 * Evaluate against a row; `resolve` returns a referenced column's value, a
	 * `FormulaErrorValue` for a referenced formula that failed, or `undefined`
	 * if no such column exists. Errors come back as their code text.
	 */
	evaluate: <ReferenceValue>(
		resolve: (name: string) => ReferenceValue
	) => FormulaValue;
	/** Like `evaluate`, but keeps errors distinct from text that looks like one. */
	evaluateResult: <ReferenceValue>(
		resolve: (name: string) => ReferenceValue
	) => FormulaResult;
	/** Column names the formula references. */
	references: string[];
}

export type CompileResult =
	| { ok: true; formula: CompiledFormula }
	| { ok: false; code: FormulaError; message: string };

function collectReferences(node: Node, into: Set<string>) {
	switch (node.kind) {
		case "ref":
			into.add(node.name);
			break;
		case "unary":
			collectReferences(node.operand, into);
			break;
		case "binary":
			collectReferences(node.left, into);
			collectReferences(node.right, into);
			break;
		case "call":
			for (const arg of node.args) {
				collectReferences(arg, into);
			}
			break;
		default:
			break;
	}
}

function validateCalls(node: Node) {
	if (node.kind === "call") {
		if (!FUNCTIONS.get(node.name)) {
			throw new FormulaFailure(
				FORMULA_ERRORS.name,
				`Unknown function ${node.name}`
			);
		}
		for (const arg of node.args) {
			validateCalls(arg);
		}
	} else if (node.kind === "unary") {
		validateCalls(node.operand);
	} else if (node.kind === "binary") {
		validateCalls(node.left);
		validateCalls(node.right);
	}
}

/** Parse a formula once; evaluation errors become error values, never throws. */
export function compileFormula(expression: string): CompileResult {
	const source = expression.trim().replace(/^=/, "");
	if (!source) {
		return {
			ok: false,
			code: FORMULA_ERRORS.syntax,
			message: "Enter a formula",
		};
	}
	let tree: Node;
	try {
		tree = parse(tokenize(source));
		validateCalls(tree);
	} catch (error) {
		if (error instanceof FormulaFailure) {
			return { ok: false, code: error.code, message: error.message };
		}
		throw error;
	}
	const references = new Set<string>();
	collectReferences(tree, references);

	const evaluateResult = <ReferenceValue>(
		resolve: (name: string) => ReferenceValue
	): FormulaResult => {
		const evaluate: Evaluate = (node) => {
			switch (node.kind) {
				case "literal":
					return node.value;
				case "ref": {
					const value = resolve(node.name);
					if (value === undefined) {
						throw new FormulaFailure(
							FORMULA_ERRORS.ref,
							`No column named ${node.name}`
						);
					}
					if (value instanceof FormulaErrorValue) {
						throw new FormulaFailure(
							value.code,
							"Referenced formula has an error"
						);
					}
					return toFormulaValue(value);
				}
				case "unary": {
					const operand = toNumber(evaluate(node.operand));
					return node.op === "-" ? -operand : operand;
				}
				case "binary":
					return evaluateBinary(
						node.op,
						evaluate(node.left),
						evaluate(node.right)
					);
				default: {
					const fn = FUNCTIONS.get(node.name);
					return fn ? fn(node.args, evaluate) : FORMULA_ERRORS.name;
				}
			}
		};
		try {
			const result = evaluate(tree);
			return isNativeNumber(result) && !Number.isFinite(result)
				? { ok: false, code: FORMULA_ERRORS.value }
				: { ok: true, value: result };
		} catch (error) {
			if (error instanceof FormulaFailure) {
				return { ok: false, code: error.code };
			}
			throw error;
		}
	};

	return {
		ok: true,
		formula: {
			references: [...references],
			evaluate: (resolve) => {
				const result = evaluateResult(resolve);
				return result.ok ? result.value : result.code;
			},
			evaluateResult,
		},
	};
}

/**
 * Rewrite `{oldName}` references (matched like resolution: trimmed, any case)
 * to `{newName}`, leaving quoted text untouched. Used when a column is renamed
 * so formulas that name it by label keep resolving.
 */
export function renameFormulaReferences(
	expression: string,
	oldName: string,
	newName: string
): string {
	const from = oldName.trim().toLowerCase();
	if (!from || from === newName.trim().toLowerCase()) {
		return expression;
	}
	let output = "";
	let i = 0;
	while (i < expression.length) {
		const char = expression[i];
		if (char === '"') {
			// Copy a string literal verbatim (a doubled "" stays inside it).
			let j = i + 1;
			while (j < expression.length) {
				if (expression[j] === '"' && expression[j + 1] === '"') {
					j += 2;
				} else if (expression[j] === '"') {
					j++;
					break;
				} else {
					j++;
				}
			}
			output += expression.slice(i, j);
			i = j;
			continue;
		}
		if (char === "{") {
			const end = expression.indexOf("}", i + 1);
			if (end === -1) {
				output += expression.slice(i);
				break;
			}
			const name = expression.slice(i + 1, end);
			output +=
				name.trim().toLowerCase() === from
					? `{${newName.trim()}}`
					: expression.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		output += char;
		i++;
	}
	return output;
}

/**
 * Apply a column rename to every formula in `columns`; returns the same array
 * when nothing references the old label.
 */
export function renameColumnInFormulas<TColumn extends FormulaColumn>(
	columns: TColumn[],
	oldLabel: string,
	newLabel: string
): TColumn[] {
	let changed = false;
	const next = columns.map((column) => {
		const expression = column.cell.expression;
		if (column.cell.variant !== "formula" || !expression) {
			return column;
		}
		const rewritten = renameFormulaReferences(expression, oldLabel, newLabel);
		if (rewritten === expression) {
			return column;
		}
		changed = true;
		return { ...column, cell: { ...column.cell, expression: rewritten } };
	});
	return changed ? next : columns;
}

interface FormulaColumn {
	cell: { variant: string; expression?: string };
	id: string;
	label: string;
}

/**
 * Fill each formula column's value into copies of `rows`. Formulas may
 * reference any column by label (or id), including other formulas; cycles
 * yield `#CYCLE!`. Rows without formula columns are returned unchanged.
 */
export function computeFormulaColumns<TRow extends object>(
	rows: TRow[],
	columns: FormulaColumn[]
): TRow[] {
	const formulaColumns = columns.filter(
		(column) => column.cell.variant === "formula"
	);
	if (formulaColumns.length === 0) {
		return rows;
	}
	const compiled = new Map(
		formulaColumns.map((column) => [
			column.id,
			compileFormula(column.cell.expression ?? ""),
		])
	);
	const byName = new Map<string, FormulaColumn>();
	for (const column of columns) {
		byName.set(column.id.toLowerCase(), column);
	}
	for (const column of columns) {
		byName.set(column.label.trim().toLowerCase(), column);
	}

	return rows.map((row) => {
		const rowValues = formulaRowInputSchema.parse(row);
		const results = new Map<string, FormulaResult>();
		const visiting = new Set<string>();

		const computeColumn = (column: FormulaColumn): FormulaResult => {
			const cached = results.get(column.id);
			if (cached !== undefined) {
				return cached;
			}
			if (visiting.has(column.id)) {
				return { ok: false, code: FORMULA_ERRORS.cycle };
			}
			const result = compiled.get(column.id);
			if (!result?.ok) {
				return { ok: false, code: result?.code ?? FORMULA_ERRORS.syntax };
			}
			visiting.add(column.id);
			const value = result.formula.evaluateResult((name) => {
				const target = byName.get(name.trim().toLowerCase());
				if (!target) {
					return undefined;
				}
				if (target.cell.variant !== "formula") {
					return rowValues[target.id] ?? null;
				}
				const referenced = computeColumn(target);
				return referenced.ok
					? referenced.value
					: new FormulaErrorValue(referenced.code);
			});
			visiting.delete(column.id);
			results.set(column.id, value);
			return value;
		};

		const next = { ...row };
		for (const column of formulaColumns) {
			const result = computeColumn(column);
			Object.assign(next, {
				[column.id]: result.ok ? result.value : result.code,
			});
		}
		return next;
	});
}
