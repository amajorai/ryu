import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import type {
	Assertion,
	AssertionOptions,
	EvalMessage,
} from "@/src/lib/api/gateway.ts";

/** Promptfoo JSON/YAML documents retain additive fields and YAML numeric scalars. */
export type PromptfooValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| PromptfooValue[]
	| PromptfooDocument;
export interface PromptfooDocument {
	[key: string]: PromptfooValue;
}
const numericScalarSchema = z.union([
	z.number(),
	z.literal(Number.NaN),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const promptfooValueSchema: z.ZodType<PromptfooValue> = z.lazy(() =>
	z.union([
		z.string(),
		numericScalarSchema,
		z.boolean(),
		z.null(),
		z.undefined(),
		z.array(promptfooValueSchema),
		z.record(z.string(), promptfooValueSchema),
	])
);
const documentInputSchema = z.record(z.string(), promptfooValueSchema);
const promptfooDocumentSchema = z.custom<PromptfooDocument>(
	(value) => documentInputSchema.safeParse(value).success
);
const retainedValueSchema = z.custom<PromptfooValue>(
	(value) => promptfooValueSchema.safeParse(value).success
);
const messageRoleSchema = z.enum(["assistant", "system", "user"]);
function isString(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): value is string {
	return z.string().safeParse(value).success;
}
function isNumber(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): value is number {
	return numericScalarSchema.safeParse(value).success;
}
function isBoolean(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): value is boolean {
	return z.boolean().safeParse(value).success;
}

export function parsePromptfooValue(
	value: Parameters<typeof retainedValueSchema.parse>[0]
): PromptfooValue {
	return retainedValueSchema.parse(value);
}
export function parsePromptfooDocument(
	value: Parameters<typeof promptfooDocumentSchema.parse>[0]
): PromptfooDocument {
	return promptfooDocumentSchema.parse(value);
}

export type PromptfooFormat = "csv" | "json" | "jsonl" | "yaml";

export interface PromptfooPrompt {
	content: string;
	id: string;
	messages: EvalMessage[];
	name: string;
	type: "chat" | "text";
}

export interface PromptfooTest {
	assertions: Assertion[];
	context?: PromptfooValue;
	description: string;
	expected?: string;
	id?: string;
	inheritDefaultTest?: boolean;
	messages?: EvalMessage[];
	metadata: PromptfooDocument;
	options: PromptfooDocument;
	prompt?: string;
	provider?: string;
	providerOutput?: PromptfooValue;
	providers: string[];
	threshold?: number;
	vars: PromptfooDocument;
}

export interface PromptfooConfig {
	defaultTest?: PromptfooValue;
	prompts: PromptfooPrompt[];
	providers: string[];
	tests: PromptfooTest[];
	[key: string]: PromptfooValue | PromptfooPrompt[] | PromptfooTest[];
}

export type PromptfooRelatedFiles = Record<string, string>;

function isRecord(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): value is PromptfooDocument {
	return promptfooDocumentSchema.safeParse(value).success;
}

function asString(
	value: Parameters<typeof promptfooValueSchema.parse>[0],
	fallback = ""
): string {
	return isString(value) ? value : fallback;
}

function assertionValueText(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): string | null {
	if (isString(value) || isNumber(value) || isBoolean(value)) {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => assertionValueText(item) ?? JSON.stringify(item))
			.join(",");
	}
	if (isRecord(value)) {
		return JSON.stringify(value);
	}
	return null;
}

function asRecord(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): PromptfooDocument {
	return isRecord(value) ? value : {};
}

function asMessages(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): EvalMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		if (!isRecord(item)) {
			return [];
		}
		const role = asString(item.role, "user");
		if (!["assistant", "system", "user"].includes(role)) {
			return [];
		}
		return [
			{
				content: asString(item.content),
				role: messageRoleSchema.parse(role),
			},
		];
	});
}

function slug(value: string, fallback: string): string {
	const result = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return result || fallback;
}

function normalizePrompt(
	value: Parameters<typeof promptfooValueSchema.parse>[0],
	index: number
): PromptfooPrompt {
	if (isString(value)) {
		return {
			content: value,
			id: `prompt-${index + 1}`,
			messages: [],
			name: `Prompt ${index + 1}`,
			type: "text",
		};
	}
	const item = asRecord(value);
	const messages = asMessages(item.messages);
	const content = asString(
		item.content ?? item.prompt ?? item.template ?? item.source
	);
	const name = asString(item.name ?? item.label, `Prompt ${index + 1}`);
	return {
		content,
		id: asString(item.id, slug(name, `prompt-${index + 1}`)),
		messages,
		name,
		type: messages.length > 0 || item.type === "chat" ? "chat" : "text",
	};
}

function normalizeAssertion(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): Assertion | null {
	if (isString(value)) {
		return { kind: "contains", value };
	}
	const item = asRecord(value);
	const rawKind = asString(item.kind ?? item.type).replaceAll("-", "_");
	const negatedKind = rawKind.startsWith("not_");
	const kind = negatedKind ? rawKind.slice("not_".length) : rawKind;
	const nestedOptions = asRecord(item.options);
	const options: AssertionOptions = {};
	for (const source of [nestedOptions, item]) {
		if (isNumber(source.threshold)) {
			options.threshold = source.threshold;
		}
		if (isNumber(source.weight)) {
			options.weight = source.weight;
		}
		if (isString(source.provider)) {
			options.provider = source.provider;
		}
		if (isString(source.rubric_prompt)) {
			options.rubric_prompt = source.rubric_prompt;
		} else if (isString(source.rubricPrompt)) {
			options.rubric_prompt = source.rubricPrompt;
		}
		if (isString(source.transform)) {
			options.transform = source.transform;
		}
		if (isString(source.metric)) {
			options.metric = source.metric;
		}
		if (isRecord(source.config)) {
			options.config = source.config;
		}
		if (isBoolean(source.not)) {
			options.not = source.not;
		}
	}
	if (negatedKind && !isBoolean(item.not) && !isBoolean(nestedOptions.not)) {
		options.not = true;
	}
	const withOptions = (assertion: Assertion): Assertion =>
		Object.keys(options).length > 0 ? { ...assertion, options } : assertion;
	const simpleKind = z
		.enum([
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		])
		.safeParse(kind);
	if (simpleKind.success) {
		return withOptions({ kind: simpleKind.data });
	}
	if (kind === "assert_set") {
		const nestedValue = item.assertions ?? item.value;
		const nested: PromptfooValue[] = Array.isArray(nestedValue)
			? nestedValue
			: [];
		return withOptions({
			assertions: nested.flatMap((entry) => {
				const normalized = normalizeAssertion(entry);
				return normalized ? [normalized] : [];
			}),
			kind: "assert_set",
		});
	}
	if (
		[
			"llm_judge",
			"llm_rubric",
			"similar",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		].includes(kind)
	) {
		if (kind === "similar") {
			return withOptions({
				kind: "similar",
				value: assertionValueText(item.value ?? item.expected) ?? "",
			});
		}
		const rubricKind = z
			.enum([
				"llm_judge",
				"llm_rubric",
				"factuality",
				"context_faithfulness",
				"answer_relevance",
			])
			.parse(kind);
		return withOptions({
			kind: rubricKind,
			rubric: asString(item.rubric ?? item.rubricPrompt ?? item.value),
		});
	}
	const valueText = assertionValueText(item.value ?? item.expected);
	if (valueText === null) {
		return null;
	}
	const supported = z
		.enum([
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
		])
		.safeParse(kind);
	if (!supported.success) {
		return null;
	}
	return withOptions({
		kind: supported.data,
		value: valueText,
	});
}

function normalizeTest(
	value: Parameters<typeof promptfooValueSchema.parse>[0],
	index: number
): PromptfooTest {
	const item = asRecord(value);
	const rawAssertions = item.assertions ?? item.assert ?? item.assertion;
	const assertionValues = Array.isArray(rawAssertions)
		? rawAssertions
		: rawAssertions === undefined
			? []
			: [rawAssertions];
	const assertions = assertionValues.flatMap((assertion) => {
		const normalized = normalizeAssertion(assertion);
		return normalized ? [normalized] : [];
	});
	const prompt = asString(item.prompt ?? item.input);
	const messages = asMessages(item.messages);
	const providers = Array.isArray(item.providers)
		? item.providers.filter((provider): provider is string =>
				isString(provider)
			)
		: [];
	const provider = isString(item.provider) ? item.provider : undefined;
	if (provider && !providers.includes(provider)) {
		providers.unshift(provider);
	}
	const threshold = isNumber(item.threshold) ? item.threshold : undefined;
	return {
		assertions,
		context: item.context,
		description: asString(item.description ?? item.name, `Case ${index + 1}`),
		id: isString(item.id) ? item.id : undefined,
		expected: isString(item.expected) ? item.expected : undefined,
		inheritDefaultTest:
			item.defaultTest === false ||
			item.inheritDefaultTest === false ||
			item.skipDefaultTest === true
				? false
				: undefined,
		messages: messages.length > 0 ? messages : undefined,
		metadata: asRecord(item.metadata),
		options: asRecord(item.options),
		prompt: prompt || undefined,
		providerOutput: item.providerOutput ?? item.provider_output,
		provider,
		providers,
		threshold,
		vars: asRecord(item.vars),
	};
}

function mergeDefaultTest(
	defaultTest: PromptfooDocument,
	test: PromptfooValue
): PromptfooDocument {
	const merged = { ...defaultTest, ...asRecord(test) };
	if (isRecord(defaultTest.vars) && isRecord(asRecord(test).vars)) {
		merged.vars = {
			...asRecord(defaultTest.vars),
			...asRecord(asRecord(test).vars),
		};
	}
	return merged;
}

function providerId(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): string | null {
	if (isString(value)) {
		return value;
	}
	if (isRecord(value)) {
		const id = value.id ?? value.name ?? value.provider;
		return isString(id) ? id : null;
	}
	return null;
}

function fileReference(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): string | null {
	if (isString(value) && value.startsWith("file://")) {
		return value.slice("file://".length);
	}
	if (isRecord(value) && isString(value.file)) {
		return value.file;
	}
	return null;
}

function selectedFileReference(
	value: Parameters<typeof promptfooValueSchema.parse>[0],
	relatedFiles: PromptfooRelatedFiles
): string | null {
	const explicit = fileReference(value);
	if (explicit) {
		return explicit;
	}
	if (!isString(value)) {
		return null;
	}
	const normalized = value.replaceAll("\\", "/");
	return relatedFiles[value] !== undefined ||
		relatedFiles[normalized] !== undefined
		? value
		: relatedFiles[fileBasename(normalized)] === undefined
			? null
			: fileBasename(normalized);
}

function fileBasename(value: string): string {
	return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function relatedFileText(
	reference: string,
	relatedFiles: PromptfooRelatedFiles
): string {
	const normalized = reference.replaceAll("\\", "/");
	const text =
		relatedFiles[reference] ??
		relatedFiles[normalized] ??
		relatedFiles[fileBasename(normalized)];
	if (text === undefined) {
		throw new Error(
			`Referenced Promptfoo file "${reference}" is not in the selected files. Select the config together with its prompt/dataset files.`
		);
	}
	return text;
}

function directPromptText(text: string, reference: string): string {
	const extension = reference.toLowerCase().split(".").at(-1);
	if (extension === "txt" || extension === "md" || extension === "j2") {
		return text;
	}
	const parsed =
		extension === "yaml" || extension === "yml"
			? parseYaml(text)
			: JSON.parse(text);
	const prompt = normalizePromptfooConfig(parsed).prompts[0];
	if (prompt?.type === "chat") {
		return JSON.stringify(prompt.messages);
	}
	if (prompt?.content) {
		return prompt.content;
	}
	return text;
}

function parseStructuredFile(text: string, reference: string): PromptfooValue {
	const extension = reference.toLowerCase().split(".").at(-1);
	if (extension === "yaml" || extension === "yml") {
		return promptfooValueSchema.parse(parseYaml(text));
	}
	return promptfooValueSchema.parse(JSON.parse(text));
}

function resolveFileBackedConfig(
	value: Parameters<typeof promptfooValueSchema.parse>[0],
	relatedFiles: PromptfooRelatedFiles
): PromptfooDocument {
	if (!isRecord(value)) {
		return {};
	}
	const resolved = structuredClone(value);
	const defaultTestReference = selectedFileReference(
		resolved.defaultTest,
		relatedFiles
	);
	if (defaultTestReference) {
		const parsed = parseStructuredFile(
			relatedFileText(defaultTestReference, relatedFiles),
			defaultTestReference
		);
		if (isRecord(parsed)) {
			resolved.defaultTest = parsed;
		}
	}
	const prompts = resolved.prompts;
	if (Array.isArray(prompts)) {
		resolved.prompts = prompts.map((prompt) => {
			const reference = selectedFileReference(prompt, relatedFiles);
			if (!reference) {
				return prompt;
			}
			const text = relatedFileText(reference, relatedFiles);
			if (isString(prompt)) {
				return directPromptText(text, reference);
			}
			const object = Object.fromEntries(
				Object.entries(asRecord(prompt)).filter(([key]) => key !== "file")
			);
			object.content = directPromptText(text, reference);
			return object;
		});
	}
	const promptReference = selectedFileReference(resolved.prompt, relatedFiles);
	if (promptReference) {
		const text = relatedFileText(promptReference, relatedFiles);
		resolved.prompt = directPromptText(text, promptReference);
	}
	const tests = resolved.tests;
	const testsReference = selectedFileReference(tests, relatedFiles);
	if (testsReference) {
		const text = relatedFileText(testsReference, relatedFiles);
		resolved.tests = parsePromptfooFile(
			text,
			testsReference,
			relatedFiles
		).config.tests.map((test) => promptfooDocumentSchema.parse(test));
	} else if (Array.isArray(tests)) {
		resolved.tests = tests.flatMap((test) => {
			const reference = selectedFileReference(test, relatedFiles);
			if (!reference) {
				return [test];
			}
			const text = relatedFileText(reference, relatedFiles);
			return parsePromptfooFile(text, reference, relatedFiles).config.tests.map(
				(test) => promptfooDocumentSchema.parse(test)
			);
		});
	}
	return resolved;
}

/** Normalize a Promptfoo YAML/JSON object into the editor's stable shape. */
export function normalizePromptfooConfig(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): PromptfooConfig {
	const raw = asRecord(retainedValueSchema.parse(value));
	const promptsRaw = Array.isArray(raw.prompts) ? raw.prompts : [];
	const testsRaw = Array.isArray(raw.tests) ? raw.tests : [];
	const defaultTest = isRecord(raw.defaultTest) ? raw.defaultTest : undefined;
	const prompts =
		promptsRaw.length > 0
			? promptsRaw.map(normalizePrompt)
			: [normalizePrompt(raw.prompt ?? "", 0)];
	const providerValues =
		Array.isArray(raw.providers) && raw.providers.length > 0
			? raw.providers
			: Array.isArray(raw.targets)
				? raw.targets
				: [];
	const providers = providerValues.flatMap((provider) => {
		const id = providerId(provider);
		return id ? [id] : [];
	});
	return {
		...raw,
		prompts,
		providers,
		tests: testsRaw.map((test, index) => {
			const testRecord = asRecord(test);
			const skipDefault =
				testRecord.defaultTest === false ||
				testRecord.inheritDefaultTest === false ||
				testRecord.skipDefaultTest === true;
			return normalizeTest(
				defaultTest && !skipDefault
					? mergeDefaultTest(defaultTest, test)
					: test,
				index
			);
		}),
	};
}

function exportAssertion(assertion: Assertion): PromptfooDocument {
	const options = assertion.options ?? {};
	const exportType = (kind: string): string =>
		`${options.not === true ? "not-" : ""}${kind.replaceAll("_", "-")}`;
	const exportedOptions: PromptfooDocument = {};
	if (options.threshold !== undefined) {
		exportedOptions.threshold = options.threshold;
	}
	if (options.weight !== undefined) {
		exportedOptions.weight = options.weight;
	}
	if (options.provider) {
		exportedOptions.provider = options.provider;
	}
	if (options.rubric_prompt) {
		exportedOptions.rubricPrompt = options.rubric_prompt;
	}
	if (options.transform) {
		exportedOptions.transform = options.transform;
	}
	if (options.metric) {
		exportedOptions.metric = options.metric;
	}
	if (options.config) {
		exportedOptions.config = promptfooDocumentSchema.parse(options.config);
	}
	if (
		[
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		].includes(assertion.kind)
	) {
		return { ...exportedOptions, type: exportType(assertion.kind) };
	}
	if (assertion.kind === "assert_set") {
		return {
			...exportedOptions,
			type: exportType("assert-set"),
			value: assertion.assertions.map(exportAssertion),
		};
	}
	if (
		assertion.kind === "llm_judge" ||
		assertion.kind === "llm_rubric" ||
		assertion.kind === "similar" ||
		assertion.kind === "factuality" ||
		assertion.kind === "context_faithfulness" ||
		assertion.kind === "answer_relevance"
	) {
		const type =
			assertion.kind === "llm_judge" || assertion.kind === "llm_rubric"
				? exportType("llm-rubric")
				: exportType(assertion.kind);
		if (assertion.kind === "similar") {
			return {
				...exportedOptions,
				type: exportType("similar"),
				value: "value" in assertion ? assertion.value : "",
			};
		}
		return {
			...exportedOptions,
			rubricPrompt: "rubric" in assertion ? assertion.rubric : "",
			type,
		};
	}
	return {
		...exportedOptions,
		type: exportType(assertion.kind),
		value: "value" in assertion ? assertion.value : "",
	};
}

function exportPrompt(prompt: PromptfooPrompt): string | PromptfooDocument {
	if (prompt.type === "chat") {
		return {
			id: prompt.id,
			messages: prompt.messages.map((message) => ({ ...message })),
			name: prompt.name,
		};
	}
	const generatedPromptId = /^prompt-(\d+)$/u.exec(prompt.id);
	const generatedName = generatedPromptId
		? `Prompt ${generatedPromptId[1]}`
		: null;
	if (
		(prompt.id === "primary" && prompt.name === "Primary") ||
		(prompt.name === generatedName && generatedName !== null)
	) {
		return prompt.content;
	}
	return {
		content: prompt.content,
		id: prompt.id,
		name: prompt.name,
	};
}

/** Convert the normalized editor state back to a Promptfoo-compatible config. */
function promptfooEvaluateOptions(config: PromptfooConfig): PromptfooDocument {
	const evaluateOptions = isRecord(config.evaluateOptions)
		? { ...config.evaluateOptions }
		: {};
	const runConfig = isRecord(config.run_config) ? config.run_config : {};
	for (const [source, target] of [
		["max_concurrency", "maxConcurrency"],
		["timeout_ms", "timeoutMs"],
		["cache", "cache"],
		["repeat", "repeat"],
		["tags", "tags"],
		["delay", "delay"],
	] as const) {
		if (runConfig[source] !== undefined) {
			evaluateOptions[target] = runConfig[source];
		}
	}
	return evaluateOptions;
}

export function toPromptfooConfig(config: PromptfooConfig): PromptfooDocument {
	const evaluateOptions = promptfooEvaluateOptions(config);
	const base = Object.fromEntries(
		Object.entries(config).filter(
			([key]) =>
				key !== "targets" && key !== "run_config" && key !== "evaluateOptions"
		)
	);
	const result = promptfooDocumentSchema.parse(base);
	if (Object.keys(evaluateOptions).length > 0) {
		result.evaluateOptions = evaluateOptions;
	}
	result.prompts = config.prompts.map(exportPrompt);
	result.providers = config.providers;
	result.tests = config.tests.map((test) => {
		const exported: PromptfooDocument = {};
		if (test.description) {
			exported.description = test.description;
		}
		if (test.context !== undefined) {
			exported.context = test.context;
		}
		if (test.id) {
			exported.id = test.id;
		}
		if (test.expected) {
			exported.expected = test.expected;
		}
		if (test.inheritDefaultTest === false) {
			exported.defaultTest = false;
		}
		if (test.messages) {
			exported.messages = test.messages.map((message) => ({ ...message }));
		}
		if (Object.keys(test.metadata).length > 0) {
			exported.metadata = test.metadata;
		}
		if (Object.keys(test.options).length > 0) {
			exported.options = test.options;
		}
		if (test.prompt) {
			exported.prompt = test.prompt;
		}
		if (test.providerOutput !== undefined) {
			exported.providerOutput = test.providerOutput;
		}
		if (test.providers.length > 0) {
			exported.providers = test.providers;
		}
		if (test.provider) {
			exported.provider = test.provider;
		}
		if (test.threshold !== undefined) {
			exported.threshold = test.threshold;
		}
		exported.vars = test.vars;
		exported.assert = test.assertions.map(exportAssertion);
		return exported;
	});
	return result;
}

function parseCsv(text: string): PromptfooDocument[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];
		if (char === '"' && quoted && next === '"') {
			cell += '"';
			index += 1;
		} else if (char === '"') {
			quoted = !quoted;
		} else if (char === "," && !quoted) {
			row.push(cell);
			cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && next === "\n") {
				index += 1;
			}
			row.push(cell);
			cell = "";
			if (row.some((value) => value.length > 0)) {
				rows.push(row);
			}
			row = [];
		} else {
			cell += char;
		}
	}
	row.push(cell);
	if (row.some((value) => value.length > 0)) {
		rows.push(row);
	}
	const headers = rows.shift() ?? [];
	return rows.map((values) => {
		const result: PromptfooDocument = {};
		headers.forEach((header, index) => {
			const value = values[index] ?? "";
			if (
				[
					"assert",
					"context",
					"inheritDefaultTest",
					"metadata",
					"options",
					"providerOutput",
					"providers",
					"vars",
				].includes(header)
			) {
				try {
					result[header] = promptfooValueSchema.parse(JSON.parse(value));
				} catch {
					result[header] = header === "providerOutput" ? value : {};
				}
			} else {
				result[header] = value;
			}
		});
		return result;
	});
}

function csvCell(
	value: Parameters<typeof promptfooValueSchema.parse>[0]
): string {
	const text = isString(value) ? value : JSON.stringify(value ?? "");
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(config: PromptfooConfig): string {
	const headers = [
		"id",
		"description",
		"prompt",
		"messages",
		"vars",
		"expected",
		"context",
		"inheritDefaultTest",
		"assert",
		"metadata",
		"provider",
		"providers",
		"providerOutput",
		"options",
		"threshold",
	];
	const rows = config.tests.map((test) =>
		[
			test.id ?? "",
			test.description,
			test.prompt ?? "",
			test.messages ?? "",
			test.vars,
			test.expected ?? "",
			test.context ?? "",
			test.inheritDefaultTest === false ? false : "",
			test.assertions.map(exportAssertion),
			test.metadata,
			test.provider ?? "",
			test.providers,
			test.providerOutput ?? "",
			test.options,
			test.threshold ?? "",
		]
			.map(csvCell)
			.join(",")
	);
	return [headers.join(","), ...rows].join("\n");
}

export function serializePromptfooConfig(
	config: PromptfooConfig,
	format: PromptfooFormat
): string {
	const exported = toPromptfooConfig(config);
	if (format === "yaml") {
		return stringifyYaml(exported);
	}
	if (format === "jsonl") {
		const tests = Array.isArray(exported.tests) ? exported.tests : [];
		return tests.map((test) => JSON.stringify(test)).join("\n");
	}
	if (format === "csv") {
		return toCsv(config);
	}
	return JSON.stringify(exported, null, 2);
}

export interface ParsedPromptfooFile {
	config: PromptfooConfig;
	format: PromptfooFormat;
}

/** Parse Promptfoo config files and dataset files accepted by the editor. */
export function parsePromptfooFile(
	text: string,
	filename: string,
	relatedFiles: PromptfooRelatedFiles = {}
): ParsedPromptfooFile {
	const extension = filename.toLowerCase().split(".").at(-1);
	if (extension === "txt" || extension === "md" || extension === "j2") {
		return {
			config: normalizePromptfooConfig({ prompts: [text], tests: [] }),
			format: "json",
		};
	}
	if (extension === "csv") {
		return {
			config: normalizePromptfooConfig({ tests: parseCsv(text) }),
			format: "csv",
		};
	}
	if (extension === "jsonl" || extension === "ndjson") {
		const tests = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		return {
			config: normalizePromptfooConfig({ tests }),
			format: "jsonl",
		};
	}
	const value =
		extension === "yaml" || extension === "yml"
			? parseYaml(text)
			: JSON.parse(text);
	return {
		config: normalizePromptfooConfig(
			resolveFileBackedConfig(value, relatedFiles)
		),
		format: extension === "yaml" || extension === "yml" ? "yaml" : "json",
	};
}
