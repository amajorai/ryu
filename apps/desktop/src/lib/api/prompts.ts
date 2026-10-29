import {
	type PromptChatEntry,
	type PromptModelConfig,
	type PromptSummaryWire,
	type PromptVersionWire,
	promptSummaryWireSchema,
	promptVersionWireSchema,
} from "@ryuhq/protocol/prompt-hub";
import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";

/**
 * Core's prompt registry (`/api/prompts`): prompts authored on this node plus
 * the read-only mirror of the organization registry when the node is signed
 * in. The wire shapes are the shared `@ryuhq/protocol/prompt-hub` contract.
 */

export type PromptSummary = PromptSummaryWire;
export type PromptVersion = PromptVersionWire;

const syncStatusSchema = z
	.object({
		lastSyncedAt: z.string().nullable().catch(null),
		lastError: z.string().nullable().catch(null),
	})
	.catch(() => ({ lastSyncedAt: null, lastError: null }));

const listSchema = z.object({
	prompts: z.array(promptSummaryWireSchema),
	organizationId: z.string().nullable().catch(null),
	sync: syncStatusSchema,
});
const promptSchema = z.object({ prompt: promptSummaryWireSchema });
const versionSchema = z.object({ version: promptVersionWireSchema });
const committedSchema = z.object({
	prompt: promptSummaryWireSchema,
	version: promptVersionWireSchema,
});
const versionsSchema = z.object({
	prompt: promptSummaryWireSchema,
	versions: z.array(promptVersionWireSchema),
	nextBefore: z.number().int().nullable().catch(null),
});
const syncSchema = z.object({
	synced: z.boolean(),
	reason: z.string().optional(),
	report: z
		.object({
			mirrored: z.number(),
			removed: z.number(),
			conflicts: z.array(z.string()),
		})
		.optional(),
});

const promptPath = (name: string) => `/api/prompts/${encodeURIComponent(name)}`;

export interface PromptList {
	organizationId: string | null;
	prompts: PromptSummary[];
	sync: { lastError: string | null; lastSyncedAt: string | null };
}

export function listPrompts(target: ApiTarget): Promise<PromptList> {
	return request(target, "/api/prompts", {}, listSchema);
}

export function listPromptVersions(
	target: ApiTarget,
	name: string,
	before?: number
): Promise<z.infer<typeof versionsSchema>> {
	const query = before === undefined ? "" : `?before=${before}`;
	return request(
		target,
		`${promptPath(name)}/versions${query}`,
		{},
		versionsSchema
	);
}

export async function getPromptVersion(
	target: ApiTarget,
	name: string,
	version: number
): Promise<PromptVersion> {
	return (
		await request(
			target,
			`${promptPath(name)}/versions/${version}`,
			{},
			versionSchema
		)
	).version;
}

export interface PromptVersionDraft {
	commitMessage?: string;
	expectedLatestVersion?: number;
	labels?: string[];
	messages?: PromptChatEntry[];
	modelConfig?: PromptModelConfig;
	template?: string;
	type: "text" | "chat";
}

export function createPrompt(
	target: ApiTarget,
	input: { description?: string; name: string; version: PromptVersionDraft }
): Promise<z.infer<typeof committedSchema>> {
	return request(
		target,
		"/api/prompts",
		{ method: "POST", body: input },
		committedSchema
	);
}

export function commitPromptVersion(
	target: ApiTarget,
	name: string,
	version: PromptVersionDraft
): Promise<z.infer<typeof committedSchema>> {
	return request(
		target,
		`${promptPath(name)}/versions`,
		{ method: "POST", body: version },
		committedSchema
	);
}

export async function movePromptLabel(
	target: ApiTarget,
	name: string,
	label: string,
	version: number | null
): Promise<PromptSummary> {
	const path = `${promptPath(name)}/labels/${encodeURIComponent(label)}`;
	const response =
		version === null
			? await request(target, path, { method: "DELETE" }, promptSchema)
			: await request(
					target,
					path,
					{ method: "PUT", body: { version } },
					promptSchema
				);
	return response.prompt;
}

export async function deletePrompt(
	target: ApiTarget,
	name: string
): Promise<void> {
	await request(
		target,
		promptPath(name),
		{ method: "DELETE" },
		z.object({ deleted: z.boolean() })
	);
}

export function syncPrompts(
	target: ApiTarget
): Promise<z.infer<typeof syncSchema>> {
	return request(target, "/api/prompts/sync", { method: "POST" }, syncSchema);
}
