import { translate as tl } from "@ryu/i18n/lite";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type Evaluate,
	evaluateBinary,
	FUNCTIONS,
	formulaRowInputSchema,
	toFormulaValue,
	toNumber,
} from "./data-grid-formula-functions.ts";
import {
	FORMULA_ERRORS,
	type FormulaError,
	FormulaErrorValue,
	FormulaFailure,
	type FormulaValue,
	type Node,
	parse,
	tokenize,
} from "./data-grid-formula-syntax.ts";

// A small, safe spreadsheet-formula language for database formula columns.
// Expressions reference other columns as `{Column name}` and support
// arithmetic, comparison, `&` concatenation, and a fixed function set.
// Nothing is evaluated as code: input is tokenized, parsed into an AST,
// and interpreted.
//
// Core evaluates the same language for read-only SQL queries in
// `crates/core/spaces/src/database_formula.rs`; keep the two in step.

export {
	FORMULA_FUNCTION_NAMES,
	toFormulaValue,
} from "./data-grid-formula-functions.ts";
export {
	FORMULA_ERRORS,
	FORMULA_MAX_DEPTH,
	FORMULA_MAX_TEXT_LENGTH,
	FORMULA_MAX_TOKENS,
	type FormulaError,
	FormulaErrorValue,
	type FormulaValue,
	isFormulaError,
} from "./data-grid-formula-syntax.ts";

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
				tl("Unknown function {name}", { name: node.name })
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
