// Prompt Studio: Promptfoo suite config <-> editor state conversion.

import type { CodeEvaluatorSpec, EvalMessage } from "@/src/lib/api/gateway.ts";
import {
	isNumber,
	isRecord,
	isString,
	parseRunTags,
	parseThreshold,
	type TestCaseRow,
} from "@/src/lib/prompt-studio.ts";
import {
	normalizePromptfooConfig,
	type PromptfooConfig,
	type PromptfooDocument,
	type PromptfooPrompt,
	type PromptfooTest,
	parsePromptfooDocument,
	parsePromptfooValue,
} from "@/src/lib/promptfoo.ts";

export interface PendingPromptfooImport {
	config: PromptfooConfig;
	filename: string;
	warnings: string[];
}

export function promptfooImportWarnings(config: PromptfooConfig): string[] {
	const warnings: string[] = [];
	if (Array.isArray(config.functions) && config.functions.length > 0) {
		warnings.push(
			"Dynamic functions are retained as configuration but are not executed during import; use an explicit Core-sandbox code evaluator to run user code."
		);
	}
	return warnings;
}

export function promptfooConfigExtras(
	config: PromptfooConfig
): PromptfooDocument {
	const editorKeys = new Set([
		"code_evaluators",
		"defaultTest",
		"evaluators",
		"commandLineOptions",
		"evaluateOptions",
		"judge_model",
		"prompt",
		"prompts",
		"providers",
		"run_config",
		"targets",
		"tests",
	]);
	return parsePromptfooDocument(
		Object.fromEntries(
			Object.entries(config).filter(([key]) => !editorKeys.has(key))
		)
	);
}

export function promptfooRunConfig(config: PromptfooConfig): PromptfooDocument {
	const merged: PromptfooDocument = {};
	for (const key of ["commandLineOptions", "evaluateOptions", "run_config"]) {
		const source = config[key];
		if (isRecord(source)) {
			Object.assign(merged, source);
		}
	}
	return merged;
}

export function numericRunOption(
	config: PromptfooDocument,
	...keys: string[]
): number | undefined {
	for (const key of keys) {
		if (isNumber(config[key])) {
			return config[key];
		}
	}
	return undefined;
}

export function runTagsFromConfig(config: PromptfooDocument): string {
	return isRecord(config.tags)
		? Object.entries(config.tags)
				.filter((entry): entry is [string, string] => isString(entry[1]))
				.map(([key, value]) => `${key}=${value}`)
				.join(", ")
		: "";
}

export interface PromptVariantRow {
	content: string;
	id: string;
	messages: EvalMessage[];
	name: string;
	type: "chat" | "text";
}

export function promptVariantFromConfig(
	prompt: PromptfooPrompt
): PromptVariantRow {
	return {
		content: prompt.content,
		id: prompt.id,
		messages: prompt.messages,
		name: prompt.name,
		type: prompt.type,
	};
}

export function promptfooTestToRow(
	test: PromptfooTest,
	index: number
): TestCaseRow {
	return {
		assertions: test.assertions,
		context: test.context,
		expected: test.expected ?? "",
		inheritDefaultTest: test.inheritDefaultTest,
		id: test.id ?? crypto.randomUUID(),
		input: test.prompt ?? "",
		messages: test.messages,
		metadata: test.metadata,
		name: test.description || `Case ${index + 1}`,
		options: test.options,
		provider: test.provider,
		providerOutput: test.providerOutput,
		providers: test.providers,
		threshold: test.threshold === undefined ? "" : String(test.threshold),
		vars: test.vars,
	};
}

export function rowToPromptfooTest(row: TestCaseRow): PromptfooTest {
	return {
		assertions: row.assertions,
		context: parsePromptfooValue(row.context),
		description: row.name,
		expected: row.expected.trim() || undefined,
		inheritDefaultTest: row.inheritDefaultTest,
		messages: row.messages,
		metadata: parsePromptfooDocument(row.metadata),
		options: parsePromptfooDocument(row.options),
		prompt: row.input || undefined,
		provider: row.provider,
		providerOutput: parsePromptfooValue(row.providerOutput),
		providers: row.providers,
		id: row.id,
		threshold: parseThreshold(row.threshold),
		vars: parsePromptfooDocument(row.vars),
	};
}

export function suiteConfigFromEditor(
	promptDraft: string,
	variants: PromptVariantRow[],
	rows: TestCaseRow[],
	providers: string[],
	judgeModel: string,
	evaluators: string[],
	codeEvaluators: CodeEvaluatorSpec[] = [],
	defaultTest?: PromptfooDocument,
	runConfig?: PromptfooDocument,
	configExtras: PromptfooDocument = {}
): PromptfooConfig {
	const prompts: PromptfooPrompt[] = [
		{
			content: promptDraft,
			id: "primary",
			messages: [],
			name: "Primary",
			type: "text",
		},
		...variants,
	];
	const config = {
		...configExtras,
		evaluators,
		judge_model: judgeModel.trim() || undefined,
		prompts,
		providers,
		tests: rows.map(rowToPromptfooTest),
	};
	const imported = parsePromptfooDocument(config);
	if (defaultTest && Object.keys(defaultTest).length > 0) {
		imported.defaultTest = defaultTest;
	}
	if (runConfig && Object.keys(runConfig).length > 0) {
		imported.run_config = runConfig;
	}
	if (codeEvaluators.length > 0) {
		imported.code_evaluators = parsePromptfooValue(codeEvaluators);
	}
	return normalizePromptfooConfig(imported);
}

export function runConfigFromEditor(
	maxConcurrency: number,
	timeoutMs: number,
	repeat: number,
	cache: boolean,
	tags: string
) {
	return {
		cache,
		max_concurrency: maxConcurrency,
		repeat,
		tags: parseRunTags(tags),
		timeout_ms: timeoutMs,
	};
}
