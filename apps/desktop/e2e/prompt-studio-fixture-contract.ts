import { z } from "zod";
import {
	type PluginValue,
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import {
	promptReviewWireSchema,
	promptRunWireSchema,
	promptSuiteVersionWireSchema,
	promptSuiteWireSchema,
} from "../src/lib/api/prompt-suite-wire-contracts.ts";
import { parseProofJson } from "./fixture-json.ts";

const promptVersionFields = z.object({
	agent_id: z.string(),
	created_at: z.number(),
	id: z.string(),
	label: z.string().nullable(),
	prompt: z.string(),
});
export const promptVersionFixtureSchema = z.custom<
	z.output<typeof promptVersionFields>
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		promptVersionFields.safeParse(value).success
);
export type PromptVersionFixture = z.output<typeof promptVersionFixtureSchema>;
export type PromptSuiteFixture = z.output<typeof promptSuiteWireSchema>;
export type PromptSuiteVersionFixture = z.output<
	typeof promptSuiteVersionWireSchema
> & { config: PluginValue; label: string | null };
export type PromptRunFixture = z.output<typeof promptRunWireSchema>;
export interface PromptReviewFixture {
	comment: string | null;
	highlighted: boolean;
	pass: boolean | null;
	result_key: string;
	run_id: string;
	score: number | null;
	updated_at: number;
}
const suiteVersionFields = z.object({
	config: pluginValueSchema,
	label: z.string().nullable(),
});
const suiteVersionFixtureSchema = z.custom<PromptSuiteVersionFixture>(
	(value) =>
		promptSuiteVersionWireSchema.safeParse(value).success &&
		suiteVersionFields.safeParse(value).success
);
const reviewFields = z.object({
	comment: z.string().nullable(),
	highlighted: z.boolean(),
	pass: z.boolean().nullable(),
	score: z.number().nullable(),
});
const reviewFixtureSchema = z.custom<PromptReviewFixture>(
	(value) =>
		promptReviewWireSchema.safeParse(value).success &&
		reviewFields.safeParse(value).success
);
const persistedStateSchema = z
	.object({
		agentVersions: z.array(promptVersionFixtureSchema),
		prompt: z.string(),
		reviews: z.array(z.tuple([z.string(), reviewFixtureSchema])),
		runCounter: z.number().int().nonnegative(),
		runs: z.array(promptRunWireSchema),
		suite: promptSuiteWireSchema.nullable(),
		suiteVersions: z.array(suiteVersionFixtureSchema),
	})
	.partial();
export function parsePromptStudioFixtureState(raw: string) {
	return persistedStateSchema.parse(parseProofJson(raw));
}
export interface CapturedPromptStudioRequest {
	body: PluginValue;
	method: string;
	path: string;
}
export interface PromptStudioProofSnapshot {
	abortedPreviewChats: number;
	abortedRuns: number;
	draft: string;
	prompt: string;
	promptVersions: PromptVersionFixture[];
	requests: CapturedPromptStudioRequest[];
	reviews: Record<string, PromptReviewFixture>;
	runs: PromptRunFixture[];
	suite: PromptSuiteFixture | null;
	suiteVersions: PromptSuiteVersionFixture[];
}
export interface PromptStudioFixtureHooks {
	armFailure: (operation: string) => void;
	holdNextEvalRun: () => void;
	holdNextPreviewChat: () => void;
	releaseInitialSuiteList: () => void;
	snapshot: () => PromptStudioProofSnapshot;
}
export const promptVersionSaveFixtureSchema = z.object({
	label: z.string().nullish(),
	prompt: z.string().nullish(),
});
export const suiteSaveFixtureSchema = z.object({
	agent_id: z.string().nullish(),
	config: pluginValueSchema.optional(),
	label: z.string().nullish(),
	name: z.string().nullish(),
});
export const runSaveFixtureSchema = z.object({
	name: z.string().nullish(),
	request: pluginValueSchema.optional(),
	result: pluginValueSchema.optional(),
});
export const nameSaveFixtureSchema = z.object({ name: z.string().nullish() });
export const labelSaveFixtureSchema = z.object({
	label: z.string().nullish(),
});
