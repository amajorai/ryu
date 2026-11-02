// Dataset parsing for the shared eval CI gate (see `eval-gate.ts`): turns a
// JSON / JSONL / CSV dataset file into the Gateway's `EvalDatasetCase` wire
// shape so `ryu eval` and the GitHub Action replay identical cases.

import { z } from "zod";
import { assertionSchema, type EvalDatasetCase } from "./gateway.ts";

/** File formats `parseEvalDataset` understands. */
export type EvalDatasetFormat = "csv" | "json" | "jsonl";

/** Thrown for a dataset file that cannot become Gateway eval cases. */
export class EvalDatasetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalDatasetError";
	}
}

/** A UTF-8 byte-order mark spreadsheet exports often prepend to CSV. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfe_ff);

/** Largest dataset a gate run accepts; Gateway caps a run well below this. */
const MAX_DATASET_CASES = 10_000;

const PROMPT_KEYS = ["prompt", "input", "question", "query"] as const;
const EXPECTED_KEYS = [
	"expected",
	"expected_output",
	"expectedOutput",
	"answer",
	"reference",
] as const;
/** Row keys copied onto the Gateway case unchanged (JSON forms only). */
const PASSTHROUGH_KEYS = [
	"assertions",
	"description",
	"evaluators",
	"messages",
	"metadata",
	"options",
	"provider",
	"providers",
	"threshold",
] as const;
const RESERVED_KEYS = new Set<string>([
	...PROMPT_KEYS,
	...EXPECTED_KEYS,
	...PASSTHROUGH_KEYS,
	"context",
	"id",
	"vars",
]);

const rowSchema = z.record(z.string(), z.json());
type DatasetRow = z.infer<typeof rowSchema>;
const datasetEnvelopeSchema = z.object({
	cases: z.array(z.json()).optional(),
	dataset: z.array(z.json()).optional(),
	// `@ryuhq/sdk/evals` writes `{ name, items }`; accept it so one file
	// serves both the SDK and the CLI/Action gate.
	items: z.array(z.json()).optional(),
	tests: z.array(z.json()).optional(),
});
const caseFieldsSchema = z.looseObject({
	assertions: z.array(assertionSchema).optional(),
	description: z.string().optional(),
	evaluators: z.array(z.string()).optional(),
	messages: z
		.array(
			z.object({
				content: z.string(),
				role: z.enum(["assistant", "system", "user"]),
			})
		)
		.optional(),
	metadata: z.record(z.string(), z.json()).optional(),
	options: z
		.object({
			cache: z.boolean().optional(),
			prefix: z.string().optional(),
			suffix: z.string().optional(),
			timeout_ms: z.number().int().positive().optional(),
			transform: z.string().optional(),
			transform_vars: z.string().optional(),
		})
		.optional(),
	provider: z.string().optional(),
	providers: z.array(z.string()).optional(),
	threshold: z.number().min(0).max(1).optional(),
	vars: z.record(z.string(), z.json()).optional(),
});

/** Pick the dataset format from a file name, falling back to the content. */
export function detectEvalDatasetFormat(
	text: string,
	fileName?: string
): EvalDatasetFormat {
	const lower = fileName?.toLowerCase() ?? "";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
		return "jsonl";
	}
	if (lower.endsWith(".json")) {
		return "json";
	}
	if (lower.endsWith(".csv")) {
		return "csv";
	}
	const trimmed = text.trimStart();
	if (trimmed.startsWith("[")) {
		return "json";
	}
	if (trimmed.startsWith("{")) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			return "jsonl";
		}
	}
	return "csv";
}

/**
 * Parse RFC 4180 CSV into rows of cells. Quoted fields may contain commas,
 * doubled quotes, and line breaks; CRLF and LF line endings are both accepted.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let index = 0;
	const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
	while (index < source.length) {
		const char = source[index];
		if (quoted) {
			if (char === '"' && source[index + 1] === '"') {
				cell += '"';
				index += 2;
				continue;
			}
			if (char === '"') {
				quoted = false;
			} else {
				cell += char;
			}
			index += 1;
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
		} else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (char === "\r" && source[index + 1] === "\n") {
				index += 1;
			}
		} else {
			cell += char;
		}
		index += 1;
	}
	if (quoted) {
		throw new EvalDatasetError("CSV ends inside a quoted field");
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function csvRows(text: string): DatasetRow[] {
	const [header, ...body] = parseCsv(text);
	if (!header) {
		return [];
	}
	const columns = header.map((name) => name.trim());
	return body.map((cells, rowIndex) => {
		if (cells.length > columns.length) {
			throw new EvalDatasetError(
				`CSV row ${rowIndex + 2} has ${cells.length} cells but the header has ${columns.length}`
			);
		}
		const row: DatasetRow = {};
		for (const [column, name] of columns.entries()) {
			if (name !== "") {
				row[name] = cells[column] ?? "";
			}
		}
		return row;
	});
}

function jsonRows(text: string): DatasetRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new EvalDatasetError(
			`dataset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const list = Array.isArray(parsed)
		? parsed
		: (() => {
				const envelope = datasetEnvelopeSchema.safeParse(parsed);
				const rows = envelope.success
					? (envelope.data.cases ??
						envelope.data.items ??
						envelope.data.dataset ??
						envelope.data.tests)
					: undefined;
				if (!rows) {
					throw new EvalDatasetError(
						"a JSON dataset must be an array of cases or an object with a `cases` (or `items`) array"
					);
				}
				return rows;
			})();
	return list.map((value, index) => objectRow(value, `case ${index + 1}`));
}

function jsonlRows(text: string): DatasetRow[] {
	const rows: DatasetRow[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line.trim() === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new EvalDatasetError(
				`JSONL line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		rows.push(objectRow(parsed, `JSONL line ${index + 1}`));
	}
	return rows;
}

function objectRow(value: unknown, label: string): DatasetRow {
	const parsed = rowSchema.safeParse(value);
	if (!parsed.success) {
		throw new EvalDatasetError(`${label} must be a JSON object`);
	}
	return parsed.data;
}

function firstText(
	row: DatasetRow,
	keys: readonly string[]
): string | undefined {
	for (const key of keys) {
		const value = row[key];
		if (value === undefined || value === null) {
			continue;
		}
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text.trim() !== "") {
			return text;
		}
	}
	return;
}

function parseContext(value: DatasetRow[string] | undefined): unknown {
	if (typeof value !== "string") {
		return value ?? undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return;
	}
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return value;
}

function rowToCase(row: DatasetRow, index: number): EvalDatasetCase {
	const fields = caseFieldsSchema.safeParse(row);
	if (!fields.success) {
		const issue = fields.error.issues[0];
		throw new EvalDatasetError(
			`case ${index + 1} field \`${issue?.path.join(".") ?? "?"}\` is invalid: ${issue?.message ?? "unknown"}`
		);
	}
	const prompt = firstText(row, PROMPT_KEYS) ?? "";
	const messages = fields.data.messages;
	if (prompt.trim() === "" && !(messages && messages.length > 0)) {
		throw new EvalDatasetError(
			`case ${index + 1} needs a prompt (one of: ${PROMPT_KEYS.join(", ")}) or messages`
		);
	}
	const testCase: EvalDatasetCase = { prompt };
	const id = firstText(row, ["id"]);
	if (id) {
		testCase.id = id;
	}
	const expected = firstText(row, EXPECTED_KEYS);
	if (expected !== undefined) {
		testCase.expected = expected;
	}
	const context = parseContext(row.context);
	if (context !== undefined) {
		testCase.context = context;
	}
	const vars: Record<string, z.infer<typeof rowSchema>[string]> = {
		...(fields.data.vars ?? {}),
	};
	for (const [key, value] of Object.entries(row)) {
		if (!RESERVED_KEYS.has(key)) {
			vars[key] = value;
		}
	}
	if (Object.keys(vars).length > 0) {
		testCase.vars = vars;
	}
	const { data } = fields;
	if (data.assertions) {
		testCase.assertions = data.assertions;
	}
	if (data.description) {
		testCase.description = data.description;
	}
	if (data.evaluators) {
		testCase.evaluators = data.evaluators;
	}
	if (messages) {
		testCase.messages = messages;
	}
	if (data.metadata) {
		testCase.metadata = data.metadata;
	}
	if (data.options) {
		testCase.options = data.options;
	}
	if (data.provider) {
		testCase.provider = data.provider;
	}
	if (data.providers) {
		testCase.providers = data.providers;
	}
	if (data.threshold !== undefined) {
		testCase.threshold = data.threshold;
	}
	return testCase;
}

/**
 * Turn dataset file text into Gateway eval cases. Each row needs a prompt
 * (`prompt`, `input`, `question`, or `query`) and may carry an `expected`
 * answer (`expected`, `expected_output`, `answer`, or `reference`), a
 * `context`, an `id`, and any Gateway case field (`assertions`, `evaluators`,
 * `messages`, …). Unrecognized columns become `{{vars}}`.
 */
export function parseEvalDataset(
	text: string,
	options: { fileName?: string; format?: EvalDatasetFormat } = {}
): EvalDatasetCase[] {
	const format =
		options.format ?? detectEvalDatasetFormat(text, options.fileName);
	let rows: DatasetRow[];
	if (format === "csv") {
		rows = csvRows(text);
	} else if (format === "jsonl") {
		rows = jsonlRows(text);
	} else {
		rows = jsonRows(text);
	}
	if (rows.length === 0) {
		throw new EvalDatasetError("dataset has no cases");
	}
	if (rows.length > MAX_DATASET_CASES) {
		throw new EvalDatasetError(
			`dataset has ${rows.length} cases; the limit is ${MAX_DATASET_CASES}`
		);
	}
	return rows.map(rowToCase);
}
