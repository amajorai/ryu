import { z } from "zod";
import type {
	Assertion,
	AssertionOptions,
	CodeEvaluatorSpec,
	EvalMessage,
	EvalRunResult,
} from "./api/gateway.ts";
import { evalRunResultSchema } from "./api/gateway-eval-contracts.ts";
import { sealedLocalStorage } from "./content-seal.ts";
import {
	type PromptfooDocument,
	type PromptfooValue,
	parsePromptfooDocument,
	parsePromptfooValue,
} from "./promptfoo.ts";
export function parseThreshold(value: string): number | undefined {
	if (!value.trim()) {
		return undefined;
	}
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
}

export function parseRunTags(value: string): PromptRunTags {
	const tags: PromptRunTags = {};
	for (const item of value.split(",")) {
		const [key, ...rest] = item.split("=");
		const normalizedKey = key?.trim();
		const normalizedValue = rest.join("=").trim();
		if (normalizedKey && normalizedValue) {
			tags[normalizedKey] = normalizedValue;
		}
	}
	return tags;
}

export function linkedPromptRunId(): string | null {
	if (globalThis.window === undefined) {
		return null;
	}
	const queryString = window.location.hash.split("?")[1];
	return queryString ? new URLSearchParams(queryString).get("run_id") : null;
}

// ── Assertion kinds (UI metadata) ──────────────────────────────────────────────

export const ASSERTION_KINDS = [
	"contains",
	"not_contains",
	"equals",
	"regex",
	"icontains",
	"starts_with",
	"contains_any",
	"contains_all",
	"icontains_any",
	"icontains_all",
	"contains_json",
	"contains_html",
	"contains_xml",
	"contains_sql",
	"levenshtein",
	"latency",
	"cost",
	"assert_set",
	"is_html",
	"is_xml",
	"is_sql",
	"is_refusal",
	"moderation",
	"javascript",
	"python",
	"ruby",
	"webhook",
	"is_json",
	"json_valid",
	"llm_judge",
	"llm_rubric",
	"similar",
	"factuality",
	"context_faithfulness",
	"answer_relevance",
] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const ASSERTION_LABELS = {
	contains: "Contains",
	not_contains: "Not contains",
	equals: "Equals",
	regex: "Regex",
	icontains: "Contains (case-insensitive)",
	starts_with: "Starts with",
	contains_any: "Contains any",
	contains_all: "Contains all",
	icontains_any: "Contains any (case-insensitive)",
	icontains_all: "Contains all (case-insensitive)",
	contains_json: "Contains JSON",
	contains_html: "Contains HTML",
	contains_xml: "Contains XML",
	contains_sql: "Contains SQL",
	levenshtein: "Levenshtein",
	latency: "Latency",
	cost: "Cost",
	assert_set: "Assertion set",
	is_html: "HTML",
	is_xml: "XML",
	is_sql: "SQL",
	is_refusal: "Refusal",
	moderation: "Moderation",
	javascript: "JavaScript",
	python: "Python",
	ruby: "Ruby",
	webhook: "Webhook",
	is_json: "Valid JSON",
	json_valid: "Valid JSON",
	llm_judge: "LLM judge",
	llm_rubric: "LLM rubric",
	similar: "Similar",
	factuality: "Factuality",
	context_faithfulness: "Context faithfulness",
	answer_relevance: "Answer relevance",
} satisfies Record<AssertionKind, string>;

/** Runtime contract for the Gateway's existing tagged assertion vocabulary. */
const assertionOptionsSchema = z.object({
	config: z
		.custom<PromptfooDocument>((value) => {
			try {
				parsePromptfooDocument(value);
				return true;
			} catch {
				return false;
			}
		})
		.optional(),
	metric: z.string().optional(),
	not: z.boolean().optional(),
	provider: z.string().optional(),
	rubric_prompt: z.string().optional(),
	threshold: z.number().optional(),
	transform: z.string().optional(),
	weight: z.number().optional(),
});
const simpleAssertionKindSchema = z.enum([
	"json_valid",
	"is_json",
	"is_html",
	"is_xml",
	"is_sql",
	"is_refusal",
]);
const rubricAssertionKindSchema = z.enum([
	"llm_judge",
	"llm_rubric",
	"factuality",
	"context_faithfulness",
	"answer_relevance",
]);
const valueAssertionKindSchema = z.enum([
	"contains",
	"not_contains",
	"equals",
	"regex",
	"icontains",
	"starts_with",
	"contains_any",
	"contains_all",
	"icontains_any",
	"icontains_all",
	"contains_json",
	"contains_html",
	"contains_xml",
	"contains_sql",
	"levenshtein",
	"latency",
	"cost",
	"moderation",
	"javascript",
	"python",
	"ruby",
	"webhook",
	"similar",
]);
export const persistedAssertionSchema: z.ZodType<Assertion> = z.lazy(() =>
	z.union([
		z.object({
			kind: simpleAssertionKindSchema,
			options: assertionOptionsSchema.optional(),
		}),
		z.object({
			kind: rubricAssertionKindSchema,
			rubric: z.string(),
			options: assertionOptionsSchema.optional(),
		}),
		z.object({
			kind: valueAssertionKindSchema,
			value: z.string(),
			options: assertionOptionsSchema.optional(),
		}),
		z.object({
			kind: z.literal("assert_set"),
			assertions: z.array(persistedAssertionSchema),
			options: assertionOptionsSchema.optional(),
		}),
	])
);
export const assertionKindSchema = z.enum(ASSERTION_KINDS);
export interface PromptRunTags {
	[key: string]: string;
}
export function isString(
	value: Parameters<typeof parsePromptfooValue>[0]
): value is string {
	return z.string().safeParse(value).success;
}
export function isNumber(
	value: Parameters<typeof parsePromptfooValue>[0]
): value is number {
	return z.number().safeParse(value).success;
}
export function isBoolean(
	value: Parameters<typeof parsePromptfooValue>[0]
): value is boolean {
	return z.boolean().safeParse(value).success;
}

/** Build a default assertion with the payload required by its Gateway variant. */
export function defaultAssertion(kind: AssertionKind): Assertion {
	if (kind === "assert_set") {
		return { kind, assertions: [] };
	}
	const simple = simpleAssertionKindSchema.safeParse(kind);
	if (simple.success) {
		return { kind: simple.data };
	}
	const rubric = rubricAssertionKindSchema.safeParse(kind);
	if (rubric.success) {
		return { kind: rubric.data, rubric: "" };
	}
	return { kind: valueAssertionKindSchema.parse(kind), value: "" };
}
export function assertionText(assertion: Assertion): string {
	if (assertion.kind === "assert_set") {
		return JSON.stringify(assertion.assertions);
	}
	if ("rubric" in assertion) {
		return assertion.rubric;
	}
	return "value" in assertion ? assertion.value : "";
}
/** Keep the last valid nested assertion set while the user edits incomplete JSON. */
export function withAssertionText(
	assertion: Assertion,
	text: string
): Assertion {
	if (assertion.kind === "assert_set") {
		try {
			const parsed = z.array(z.json()).safeParse(JSON.parse(text));
			if (parsed.success) {
				return {
					kind: "assert_set",
					options: assertion.options,
					assertions: parsed.data.flatMap((value) => {
						const entry = z
							.custom<Assertion>(isPersistedAssertion)
							.safeParse(value);
						return entry.success ? [entry.data] : [];
					}),
				};
			}
		} catch {
			return assertion;
		}
		return assertion;
	}
	if ("rubric" in assertion) {
		return { ...assertion, rubric: text };
	}
	if ("value" in assertion) {
		return { ...assertion, value: text };
	}
	return assertion;
}
/** Flatten only the declared Gateway option fields; preserve the assertion discriminant. */
export function gatewayAssertion(
	assertion: Assertion
): Assertion & AssertionOptions {
	const { options, ...base } = assertion;
	return { ...base, ...options };
}

// ── Test-case rows ─────────────────────────────────────────────────────────────

export interface TestCaseRow {
	assertions: Assertion[];
	context?: PromptfooValue;
	/** Legacy convenience expected substring. */
	expected: string;
	id: string;
	inheritDefaultTest?: boolean;
	/** User message; may contain {{vars}}. */
	input: string;
	/** Ordered Promptfoo chat messages, when this case is multi-turn. */
	messages?: EvalMessage[];
	metadata: PromptfooDocument;
	name: string;
	options: PromptfooDocument;
	provider?: string;
	providerOutput?: PromptfooValue;
	providers: string[];
	/** Promptfoo-style mean assertion pass threshold, entered as 0..1. */
	threshold: string;
	vars: PromptfooDocument;
}

export function newTestCaseRow(): TestCaseRow {
	return {
		id: crypto.randomUUID(),
		name: "",
		input: "",
		metadata: {},
		options: {},
		providers: [],
		vars: {},
		expected: "",
		threshold: "",
		assertions: [],
	};
}

export interface PromptTestSuiteSnapshot {
	codeEvaluators?: CodeEvaluatorSpec[];
	defaultTest?: PromptfooDocument;
	evaluatorIds: string[];
	extraModels: string[];
	judgeModel: string;
	maxConcurrency?: number;
	repeat?: number;
	rows: TestCaseRow[];
	tags?: Record<string, string>;
	timeoutMs?: number;
}

export function parseCodeEvaluators(
	value: Parameters<typeof parsePromptfooValue>[0]
): CodeEvaluatorSpec[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		if (!isRecord(item)) {
			return [];
		}
		const id = isString(item.id) ? item.id.trim() : "";
		const lang =
			item.lang === "python" ? "python" : item.lang === "js" ? "js" : null;
		const source = isString(item.source) ? item.source : "";
		return id && lang && source ? [{ id, lang, source }] : [];
	});
}

export function isRecord(
	value: Parameters<typeof parsePromptfooValue>[0]
): value is PromptfooDocument {
	try {
		parsePromptfooDocument(value);
		return true;
	} catch {
		return false;
	}
}
export function isPersistedAssertion(
	value: Parameters<typeof persistedAssertionSchema.parse>[0]
): value is Assertion {
	return persistedAssertionSchema.safeParse(value).success;
}
type LegacyTestCaseRow = Omit<
	TestCaseRow,
	"metadata" | "options" | "providers"
> &
	Partial<Pick<TestCaseRow, "metadata" | "options" | "providers">>;
const persistedRowSchema = z.object({
	id: z.string(),
	name: z.string(),
	input: z.string(),
	expected: z.string(),
	threshold: z.string(),
	vars: z.custom<PromptfooDocument>(isRecord),
	assertions: z.array(persistedAssertionSchema),
	context: z.json().optional(),
	inheritDefaultTest: z.boolean().optional(),
	messages: z
		.array(
			z.object({
				role: z.enum(["assistant", "system", "user"]),
				content: z.string(),
			})
		)
		.optional(),
	metadata: z.custom<PromptfooDocument>(isRecord).optional(),
	options: z.custom<PromptfooDocument>(isRecord).optional(),
	provider: z.string().optional(),
	providerOutput: z.json().optional(),
	providers: z.array(z.string()).optional(),
});
export function isPersistedRow(
	value: Parameters<typeof persistedRowSchema.parse>[0]
): value is LegacyTestCaseRow {
	return persistedRowSchema.safeParse(value).success;
}

export function normalizeTestCaseRow(row: LegacyTestCaseRow): TestCaseRow {
	return {
		...newTestCaseRow(),
		...row,
		metadata: row.metadata ?? {},
		options: row.options ?? {},
		providers: row.providers ?? [],
		vars: row.vars ?? {},
	};
}

export function testSuiteKey(agentId: string): string {
	return `prompt-studio-tests:${agentId}`;
}

export function loadTestSuite(
	agentId: string | null,
	storage?: Pick<Storage, "getItem">
): PromptTestSuiteSnapshot {
	if (!agentId || (!storage && globalThis.window === undefined)) {
		return {
			evaluatorIds: [],
			extraModels: [],
			judgeModel: "",
			rows: [],
		};
	}
	try {
		const raw = (storage ?? sealedLocalStorage).getItem(testSuiteKey(agentId));
		if (!raw) {
			return {
				evaluatorIds: [],
				extraModels: [],
				judgeModel: "",
				rows: [],
			};
		}
		const parsed = parsePromptfooValue(JSON.parse(raw));
		if (!isRecord(parsed)) {
			return {
				evaluatorIds: [],
				extraModels: [],
				judgeModel: "",
				rows: [],
			};
		}
		return {
			codeEvaluators: parseCodeEvaluators(parsed.codeEvaluators),
			defaultTest: isRecord(parsed.defaultTest)
				? parsed.defaultTest
				: undefined,
			evaluatorIds: Array.isArray(parsed.evaluatorIds)
				? parsed.evaluatorIds.filter((value): value is string =>
						isString(value)
					)
				: [],
			extraModels: Array.isArray(parsed.extraModels)
				? parsed.extraModels.filter((model): model is string => isString(model))
				: [],
			judgeModel: isString(parsed.judgeModel) ? parsed.judgeModel : "",
			maxConcurrency: isNumber(parsed.maxConcurrency)
				? parsed.maxConcurrency
				: undefined,
			repeat: isNumber(parsed.repeat) ? parsed.repeat : undefined,
			tags: isRecord(parsed.tags)
				? Object.fromEntries(
						Object.entries(parsed.tags).filter(
							(entry): entry is [string, string] => isString(entry[1])
						)
					)
				: undefined,
			timeoutMs: isNumber(parsed.timeoutMs) ? parsed.timeoutMs : undefined,
			rows: Array.isArray(parsed.rows)
				? parsed.rows.flatMap((value) => {
						const entry = z
							.custom<LegacyTestCaseRow>(isPersistedRow)
							.safeParse(value);
						return entry.success ? [normalizeTestCaseRow(entry.data)] : [];
					})
				: [],
		};
	} catch {
		return {
			evaluatorIds: [],
			extraModels: [],
			judgeModel: "",
			rows: [],
		};
	}
}

export function persistTestSuite(
	agentId: string,
	snapshot: PromptTestSuiteSnapshot,
	storage?: Pick<Storage, "setItem">
): void {
	if (!storage && globalThis.window === undefined) {
		return;
	}
	try {
		(storage ?? sealedLocalStorage).setItem(
			testSuiteKey(agentId),
			JSON.stringify(snapshot)
		);
	} catch {
		// Test drafts remain usable when browser storage is unavailable or full.
	}
}

export const evalMessageSchema = z.object({
	role: z.enum(["assistant", "system", "user"]),
	content: z.string(),
});
export function isEvalMessage(
	value: Parameters<typeof evalMessageSchema.parse>[0]
): value is EvalMessage {
	return evalMessageSchema.safeParse(value).success;
}
export interface PromptVariantRun {
	promptId: string;
	promptName: string;
	result: EvalRunResult;
}
const promptVariantRunsInputSchema = z.array(
	z
		.object({
			promptId: z.string(),
			promptName: z.string(),
			result: evalRunResultSchema,
		})
		.passthrough()
);
export const resultFilterSchema = z.enum([
	"all",
	"pass",
	"fail",
	"error",
	"different",
	"highlighted",
]);

export const promptVariantRunsSchema = z.custom<PromptVariantRun[]>(
	(value) => promptVariantRunsInputSchema.safeParse(value).success
);

export function parseEvalMessages(
	value: Parameters<typeof parsePromptfooValue>[0]
): EvalMessage[] {
	const messageListInputSchema = z.array(z.json());
	const messages = z
		.custom<z.infer<typeof messageListInputSchema>>(
			(input) => messageListInputSchema.safeParse(input).success
		)
		.safeParse(value);
	if (!messages.success) {
		return [];
	}
	return messages.data.flatMap((message) => {
		const parsed = z.custom<EvalMessage>(isEvalMessage).safeParse(message);
		return parsed.success ? [parsed.data] : [];
	});
}
