// Agent-UI computed functions: the closed set of pure helpers a spec may call
// through json-render's `{ "$computed": "<name>", "args": { ... } }` prop
// expression. They let an agent build small live tools (a budget calculator, a
// loan estimator, a unit converter) from bound inputs without any code
// execution: the model only names a function and wires state into its args.
//
// Every function is total: bad or missing input yields `null` (formatters yield
// an em dash) rather than throwing, so a half-filled form never breaks the UI.
// React-free so the contract generator (scripts/gen-agent-ui-contract.ts) can
// list the same names and descriptions the renderer registers.

import type { ComputedFunction } from "@json-render/core";
import { z } from "zod";

type ComputedArgs = Parameters<ComputedFunction>[0];

interface AgentUiComputedFunction {
	description: string;
	run: ComputedFunction;
}

const MAX_LIST_LENGTH = 1000;
const FORMAT_FALLBACK = "—";

const numericTextSchema = z
	.string()
	.trim()
	.min(1)
	.transform((text) => Number(text.replaceAll(",", "")));

/** Coerce a state value to a finite number. Inputs bind strings, so numeric
 *  text ("1,250.5") counts; anything else is `null`. */
export function toFiniteNumber(value: unknown): number | null {
	const parsed = z
		.union([z.number(), numericTextSchema, z.boolean().transform(Number)])
		.safeParse(value);
	return parsed.success && Number.isFinite(parsed.data) ? parsed.data : null;
}

/** The raw state array, or null when it is not an array or is over the cap.
 *  Checked before any per-entry work so an oversized agent-supplied array costs
 *  O(1) here instead of a full traversal. */
function boundedList(value: unknown): readonly unknown[] | null {
	return Array.isArray(value) && value.length <= MAX_LIST_LENGTH ? value : null;
}

function numberList(entries: readonly unknown[]): number[] {
	const numbers: number[] = [];
	for (const entry of entries) {
		const number = toFiniteNumber(entry);
		if (number !== null) {
			numbers.push(number);
		}
	}
	return numbers;
}

/** Numbers from `values` (an array, optionally of objects read at `field`). */
function valuesFrom(args: ComputedArgs): number[] | null {
	const field = z.string().optional().safeParse(args.field);
	const values = boundedList(args.values);
	if (!values) {
		return null;
	}
	if (!(field.success && field.data)) {
		return numberList(values);
	}
	const key = field.data;
	return numberList(
		values.map(
			(entry) => z.record(z.string(), z.unknown()).safeParse(entry).data?.[key]
		)
	);
}

function finiteOrNull(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

function binary(
	args: ComputedArgs,
	op: (a: number, b: number) => number
): number | null {
	const a = toFiniteNumber(args.a);
	const b = toFiniteNumber(args.b);
	return a === null || b === null ? null : finiteOrNull(op(a, b));
}

function digitsFrom(value: unknown, fallback: number): number {
	const digits = toFiniteNumber(value);
	return digits === null
		? fallback
		: Math.min(10, Math.max(0, Math.trunc(digits)));
}

const formatStyleSchema = z
	.enum(["number", "currency", "percent", "compact"])
	.catch("number");
const currencySchema = z
	.string()
	.regex(/^[A-Za-z]{3}$/)
	.catch("USD");

function formatValue(args: ComputedArgs): string {
	const value = toFiniteNumber(args.value);
	if (value === null) {
		return FORMAT_FALLBACK;
	}
	const style = formatStyleSchema.parse(args.style);
	const digits = digitsFrom(args.digits, style === "currency" ? 2 : 0);
	const options: Intl.NumberFormatOptions = {
		maximumFractionDigits: digits,
		minimumFractionDigits: style === "currency" ? digits : 0,
	};
	if (style === "currency") {
		options.style = "currency";
		options.currency = currencySchema.parse(args.currency).toUpperCase();
	} else if (style === "percent") {
		options.style = "percent";
	} else if (style === "compact") {
		options.notation = "compact";
	}
	try {
		return new Intl.NumberFormat(undefined, options).format(value);
	} catch {
		return String(value);
	}
}

/** Standard amortized payment per period for a loan of `principal` at a
 *  per-period `rate` (0.05 = 5%) over `periods` payments. */
function payment(args: ComputedArgs): number | null {
	const rate = toFiniteNumber(args.rate);
	const periods = toFiniteNumber(args.periods);
	const principal = toFiniteNumber(args.principal);
	if (rate === null || periods === null || principal === null || periods <= 0) {
		return null;
	}
	if (rate === 0) {
		return principal / periods;
	}
	const growth = (1 + rate) ** periods;
	return finiteOrNull((principal * rate * growth) / (growth - 1));
}

export const agentUiComputedFunctions = {
	add: {
		description: "a + b",
		run: (args) => binary(args, (a, b) => a + b),
	},
	subtract: {
		description: "a - b",
		run: (args) => binary(args, (a, b) => a - b),
	},
	multiply: {
		description: "a * b",
		run: (args) => binary(args, (a, b) => a * b),
	},
	divide: {
		description: "a / b (null when b is 0)",
		run: (args) => binary(args, (a, b) => (b === 0 ? Number.NaN : a / b)),
	},
	percent: {
		description: "part / total as a fraction (format with style 'percent')",
		run: (args) => {
			const part = toFiniteNumber(args.part);
			const total = toFiniteNumber(args.total);
			return part === null || total === null || total === 0
				? null
				: finiteOrNull(part / total);
		},
	},
	sum: {
		description:
			"Sum of `values` (an array of numbers, or of objects read at `field`)",
		run: (args) => valuesFrom(args)?.reduce((total, n) => total + n, 0) ?? null,
	},
	average: {
		description: "Mean of `values` (optionally read at `field`)",
		run: (args) => {
			const values = valuesFrom(args);
			return values && values.length > 0
				? values.reduce((total, n) => total + n, 0) / values.length
				: null;
		},
	},
	min: {
		description: "Smallest of `values` (optionally read at `field`)",
		run: (args) => {
			const values = valuesFrom(args);
			return values && values.length > 0 ? Math.min(...values) : null;
		},
	},
	max: {
		description: "Largest of `values` (optionally read at `field`)",
		run: (args) => {
			const values = valuesFrom(args);
			return values && values.length > 0 ? Math.max(...values) : null;
		},
	},
	count: {
		description: "Number of entries in `values`",
		run: (args) => {
			// Counting needs no traversal, so it is not capped.
			return Array.isArray(args.values) ? args.values.length : null;
		},
	},
	round: {
		description: "Round `value` to `digits` decimal places (default 0)",
		run: (args) => {
			const value = toFiniteNumber(args.value);
			if (value === null) {
				return null;
			}
			const factor = 10 ** digitsFrom(args.digits, 0);
			return Math.round(value * factor) / factor;
		},
	},
	clamp: {
		description: "Limit `value` to the range [`min`, `max`]",
		run: (args) => {
			const value = toFiniteNumber(args.value);
			const min = toFiniteNumber(args.min) ?? Number.NEGATIVE_INFINITY;
			const max = toFiniteNumber(args.max) ?? Number.POSITIVE_INFINITY;
			return value === null ? null : Math.min(max, Math.max(min, value));
		},
	},
	payment: {
		description:
			"Loan payment per period: `principal`, per-period `rate` (0.005 = 0.5%), `periods`",
		run: payment,
	},
	format: {
		description:
			"Format `value` for display: `style` number|currency|percent|compact, optional `digits`, `currency` (ISO code, default USD)",
		run: formatValue,
	},
} satisfies Record<string, AgentUiComputedFunction>;

export type AgentUiComputedFunctionName = keyof typeof agentUiComputedFunctions;

/** The `functions` map handed to json-render's provider. */
export const agentUiFunctions: Record<string, ComputedFunction> =
	Object.fromEntries(
		Object.entries(agentUiComputedFunctions).map(([name, fn]) => [name, fn.run])
	);
