import { translate as tl } from "@ryu/i18n/lite";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

// The syntax half of the data grid formula language (see `data-grid-formula.ts`):
// values, error codes, the tokenizer and the parser.

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

export class FormulaFailure extends Error {
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
export const DECIMAL_TEXT_REGEX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export const INFINITY_TEXT_REGEX = /^[+-]?Infinity$/;
/** Longest formula, in tokens; longer input is a syntax error. */
export const FORMULA_MAX_TOKENS = 1024;
/** Deepest nesting of parentheses, signs, and calls a formula may use. */
export const FORMULA_MAX_DEPTH = 64;
/** Longest text a formula may produce, in UTF-16 code units (Excel's cell limit). */
export const FORMULA_MAX_TEXT_LENGTH = 32_767;
const IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*/;
export const ISO_DAY_REGEX = /^(\d{4})-(\d{2})-(\d{2})/;
export const MS_PER_DAY = 86_400_000;

export function tokenize(source: string): Token[] {
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
			tl('Unexpected character "{char}"', { char })
		);
	}
	if (tokens.length > FORMULA_MAX_TOKENS) {
		throw new FormulaFailure(FORMULA_ERRORS.syntax, "Formula is too long");
	}
	return tokens;
}

export type Node =
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

export function parse(tokens: Token[]): Node {
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
				return fail(tl('Unexpected "{op}"', { op: token.op }));
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
						fail(tl('Missing ")" after {name} arguments', { name: upper }));
					}
					return { kind: "call", name: upper, args };
				}
				if (upper === "TRUE" || upper === "FALSE") {
					return { kind: "literal", value: upper === "TRUE" };
				}
				throw new FormulaFailure(
					FORMULA_ERRORS.name,
					tl('Unknown name "{name}" — wrap column names in {example}', {
						example: "{braces}",
						name: token.name,
					})
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
