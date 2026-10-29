import type { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import type { ApiTarget, RequestOptions } from "./client.ts";
import { request } from "./client.ts";
import type { PluginValue } from "./plugin-wire-values.ts";
import {
	promptReviewEnvelopeSchema,
	promptReviewSaveInputSchema,
	promptReviewsEnvelopeSchema,
	type promptReviewWireSchema,
	promptRunEnvelopeSchema,
	promptRunMetaEnvelopeSchema,
	type promptRunMetaWireSchema,
	promptRunSaveInputSchema,
	promptRunsEnvelopeSchema,
	type promptRunWireSchema,
	promptSuiteCreateInputSchema,
	promptSuiteEnvelopeSchema,
	promptSuiteListEnvelopeSchema,
	promptSuiteSaveEnvelopeSchema,
	promptSuiteUpdateInputSchema,
	promptSuiteVersionEnvelopeSchema,
	promptSuiteVersionsEnvelopeSchema,
	type promptSuiteVersionWireSchema,
	type promptSuiteWireSchema,
	promptTraceEnvelopeSchema,
} from "./prompt-suite-wire-contracts.ts";

export interface PromptSuiteRecord {
	agentId: string;
	config: PluginValue;
	createdAt: number;
	id: string;
	name: string;
	updatedAt: number;
}

export interface PromptSuiteVersionMeta {
	createdAt: number;
	id: string;
	label: string | null;
	suiteId: string;
}

export interface PromptSuiteVersion extends PromptSuiteVersionMeta {
	config: PluginValue;
}

export interface PromptRunMeta {
	createdAt: number;
	id: string;
	name: string;
	suiteId: string;
}

export interface PromptRun extends PromptRunMeta {
	request: PluginValue;
	result: PluginValue;
}

export interface PromptReview {
	comment: string | null;
	highlighted: boolean;
	pass: boolean | null;
	resultKey: string;
	runId: string;
	score: number | null;
	updatedAt: number;
}

type PromptSuiteWire = z.output<typeof promptSuiteWireSchema>;
type PromptSuiteVersionWire = z.output<typeof promptSuiteVersionWireSchema>;
type PromptRunMetaWire = z.output<typeof promptRunMetaWireSchema>;
type PromptRunWire = z.output<typeof promptRunWireSchema>;
type PromptReviewWire = z.output<typeof promptReviewWireSchema>;

function toSuite(value: PromptSuiteWire): PromptSuiteRecord {
	return {
		agentId: value.agent_id,
		config: value.config,
		createdAt: value.created_at,
		id: value.id,
		name: value.name,
		updatedAt: value.updated_at,
	};
}

function toVersion(value: PromptSuiteVersionWire): PromptSuiteVersion {
	return {
		config: value.config ?? {},
		createdAt: value.created_at,
		id: value.id,
		label: value.label ?? null,
		suiteId: value.suite_id,
	};
}

function toRunMeta(value: PromptRunMetaWire): PromptRunMeta {
	return {
		createdAt: value.created_at,
		id: value.id,
		name: value.name,
		suiteId: value.suite_id,
	};
}

function toRun(value: PromptRunWire): PromptRun {
	return {
		...toRunMeta(value),
		request: value.request,
		result: value.result,
	};
}

function toReview(value: PromptReviewWire): PromptReview {
	return {
		comment: value.comment ?? null,
		highlighted: value.highlighted ?? false,
		pass: value.pass ?? null,
		resultKey: value.result_key,
		runId: value.run_id,
		score: value.score ?? null,
		updatedAt: value.updated_at,
	};
}

export async function listPromptSuites(
	target: ApiTarget,
	agentId: string
): Promise<PromptSuiteRecord[]> {
	const json = promptSuiteListEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites?agent_id=${encodeURIComponent(agentId)}`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return (json.suites ?? []).map(toSuite);
}

export async function createPromptSuite(
	target: ApiTarget,
	input: Parameters<typeof promptSuiteCreateInputSchema.parse>[0]
): Promise<{
	suite: PromptSuiteRecord;
	version: PromptSuiteVersion | null;
}> {
	const parsed = promptSuiteCreateInputSchema.parse(input);
	const json = promptSuiteSaveEnvelopeSchema.parse(
		await request(
			target,
			"/api/prompt-suites",
			{
				body: {
					agent_id: parsed.agentId,
					config: parsed.config,
					...promptSuiteLabelFields(parsed.label),
					name: parsed.name,
				},
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return {
		suite: toSuite(json.suite),
		version: json.version ? toVersion(json.version) : null,
	};
}

export async function getPromptSuite(
	target: ApiTarget,
	suiteId: string
): Promise<PromptSuiteRecord> {
	const json = promptSuiteEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return toSuite(json.suite);
}

export async function updatePromptSuite(
	target: ApiTarget,
	suiteId: string,
	input: Parameters<typeof promptSuiteUpdateInputSchema.parse>[0]
): Promise<{
	suite: PromptSuiteRecord;
	version: PromptSuiteVersion | null;
}> {
	const parsed = promptSuiteUpdateInputSchema.parse(input);
	const json = promptSuiteSaveEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}`,
			{
				body: {
					config: parsed.config,
					...promptSuiteLabelFields(parsed.label),
					name: parsed.name,
				},
				method: "PUT",
			},
			gatewayJsonValueSchema
		)
	);
	return {
		suite: toSuite(json.suite),
		version: json.version ? toVersion(json.version) : null,
	};
}

export async function deletePromptSuite(
	target: ApiTarget,
	suiteId: string
): Promise<void> {
	await request(
		target,
		`/api/prompt-suites/${encodeURIComponent(suiteId)}`,
		{
			method: "DELETE",
		},
		gatewayJsonValueSchema
	);
}

export async function listPromptSuiteVersions(
	target: ApiTarget,
	suiteId: string
): Promise<PromptSuiteVersionMeta[]> {
	const json = promptSuiteVersionsEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/versions`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return (json.versions ?? []).map((version) => ({
		createdAt: version.created_at,
		id: version.id,
		label: version.label ?? null,
		suiteId: version.suite_id,
	}));
}

export async function getPromptSuiteVersion(
	target: ApiTarget,
	suiteId: string,
	versionId: string
): Promise<PromptSuiteVersion> {
	const json = promptSuiteVersionEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/versions/${encodeURIComponent(versionId)}`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return toVersion(json.version);
}

export async function createPromptSuiteVersion(
	target: ApiTarget,
	suiteId: string,
	label?: string
): Promise<PromptSuiteVersionMeta> {
	const json = promptSuiteVersionEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/versions`,
			{
				body: promptSuiteLabelFields(label),
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return toVersion(json.version);
}

export async function restorePromptSuiteVersion(
	target: ApiTarget,
	suiteId: string,
	versionId: string
): Promise<PromptSuiteRecord> {
	const json = promptSuiteEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/versions/${encodeURIComponent(versionId)}/restore`,
			{ method: "POST" },
			gatewayJsonValueSchema
		)
	);
	return toSuite(json.suite);
}

export async function listPromptRuns(
	target: ApiTarget,
	suiteId: string
): Promise<PromptRunMeta[]> {
	const json = promptRunsEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return (json.runs ?? []).map(toRunMeta);
}

export async function savePromptRun(
	target: ApiTarget,
	suiteId: string,
	input: Parameters<typeof promptRunSaveInputSchema.parse>[0]
): Promise<PromptRunMeta> {
	const parsed = promptRunSaveInputSchema.parse(input);
	const json = promptRunMetaEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs`,
			{ body: parsed, method: "POST" },
			gatewayJsonValueSchema
		)
	);
	return toRunMeta(json.run);
}

export async function getPromptRun(
	target: ApiTarget,
	suiteId: string,
	runId: string
): Promise<PromptRun> {
	const json = promptRunEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return toRun(json.run);
}

export async function renamePromptRun(
	target: ApiTarget,
	suiteId: string,
	runId: string,
	name: string
): Promise<PromptRunMeta> {
	const json = promptRunMetaEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`,
			{ body: { name }, method: "PUT" },
			gatewayJsonValueSchema
		)
	);
	return toRunMeta(json.run);
}

export async function deletePromptRun(
	target: ApiTarget,
	suiteId: string,
	runId: string
): Promise<void> {
	await request(
		target,
		`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

export async function duplicatePromptRun(
	target: ApiTarget,
	suiteId: string,
	runId: string,
	name?: string
): Promise<PromptRunMeta> {
	const options: RequestOptions = { method: "POST" };
	if (name?.trim()) {
		options.body = { name: name.trim() };
	}
	const json = promptRunMetaEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}/duplicate`,
			options,
			gatewayJsonValueSchema
		)
	);
	return toRunMeta(json.run);
}

export async function listPromptReviews(
	target: ApiTarget,
	suiteId: string,
	runId: string
): Promise<PromptReview[]> {
	const json = promptReviewsEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}/reviews`,
			undefined,
			gatewayJsonValueSchema
		)
	);
	return (json.reviews ?? []).map(toReview);
}

export async function savePromptReview(
	target: ApiTarget,
	suiteId: string,
	runId: string,
	input: Parameters<typeof promptReviewSaveInputSchema.parse>[0]
): Promise<PromptReview> {
	const parsed = promptReviewSaveInputSchema.parse(input);
	const json = promptReviewEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}/reviews`,
			{
				body: {
					...promptReviewCommentFields(parsed.comment),
					highlighted: parsed.highlighted ?? false,
					pass: parsed.pass ?? null,
					result_key: parsed.resultKey,
					score: parsed.score ?? null,
				},
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return toReview(json.review);
}

/** Add a completed Core conversation to a durable Prompt Studio dataset. */
export async function importPromptTrace(
	target: ApiTarget,
	suiteId: string,
	runId: string
): Promise<{
	added: boolean;
	case: PluginValue;
	sourceRunId: string;
	suite: PromptSuiteRecord;
	version: PromptSuiteVersion | null;
}> {
	const json = promptTraceEnvelopeSchema.parse(
		await request(
			target,
			`/api/prompt-suites/${encodeURIComponent(suiteId)}/traces`,
			{
				body: { run_id: runId },
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return {
		added: json.added,
		case: json.case,
		sourceRunId: json.source_run_id,
		suite: toSuite(json.suite),
		version: json.version ? toVersion(json.version) : null,
	};
}

type PromptSuiteLabelFields = Pick<
	z.output<typeof promptSuiteCreateInputSchema>,
	"label"
>;
function promptSuiteLabelFields(label?: string | null): PromptSuiteLabelFields {
	const fields: PromptSuiteLabelFields = {};
	if (label?.trim()) {
		fields.label = label.trim();
	}
	return fields;
}
type PromptReviewCommentFields = Pick<
	z.output<typeof promptReviewSaveInputSchema>,
	"comment"
>;
function promptReviewCommentFields(
	comment?: string | null
): PromptReviewCommentFields {
	const fields: PromptReviewCommentFields = {};
	if (comment !== undefined) {
		fields.comment = comment;
	}
	return fields;
}
