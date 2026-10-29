import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// Typed client for the Gateway's agent-root import/export sync surface.

import { type ApiTarget, request } from "./client.ts";
import {
	type ImportItemKind,
	type ImportOutcome,
	type ImportSelection,
	importItemKindSchema,
} from "./import.ts";

/**
 * Every provider Core's `normalize_provider` accepts
 * (`apps/core/src/server/agent_sync.rs`). The one list the {@link SyncProvider}
 * type and the provider response codec are derived from, so a provider added
 * here is readable on every profile and scan response without a second edit.
 */
export const SYNC_PROVIDERS = [
	"claude",
	"codex",
	"cursor",
	"openclaw",
	"hermes",
	"muse",
	"mastra",
	"langchain",
	"persona",
	"chatgpt",
	"claude-ai",
	"other",
] as const;

export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

export interface AgentSyncProfile {
	conflictCount: number;
	exportEnabled: boolean;
	id: string;
	importEnabled: boolean;
	lastOperationId: string | null;
	provider: SyncProvider;
	root: string;
	status: string;
	updatedAt: number;
}

export interface AgentSyncProfileInput {
	exportEnabled: boolean;
	id?: string;
	importEnabled: boolean;
	provider: SyncProvider;
	root: string;
}

export interface NativeThread {
	cwd?: string;
	engine: string;
	git_branch?: string;
	id: string;
	message_count: number;
	native_session_id?: string;
	title: string;
	updated_at: number;
}

export interface AgentSyncCapabilities {
	acpLoadResume: boolean | null;
	nativeConversationExport: boolean;
	nativeThreads: boolean;
	note: string | null;
	portableBundle: boolean;
	setupImport: boolean;
}

export interface AgentSyncScanItem {
	already_exists?: boolean;
	detail?: string;
	id: string;
	kind: ImportItemKind;
	title: string;
}

export interface AgentSyncScan {
	agentId: string | null;
	capabilities: AgentSyncCapabilities;
	items: AgentSyncScanItem[];
	provider: SyncProvider;
	root: string;
	threads: NativeThread[];
	warnings: string[];
}

export interface AgentSyncImportResult {
	conflicts: number;
	dryRun: boolean;
	failed: number;
	imported: number;
	operationId: string;
	profileId: string;
	results: ImportOutcome[];
	skipped: number;
}

export interface AcpResumeStatus {
	agentId: string | null;
	conversationId: string;
	mode: "load" | "resume" | "replay" | string;
	reason: string;
}

export interface AgentSyncExportResult {
	acpResume: AcpResumeStatus[];
	agents: number;
	bundleHash: string;
	bundlePath: string;
	conflicts: number;
	conversations: number;
	destination: string;
	dryRun: boolean;
	messages: number;
	operationId: string;
	profileId: string | null;
	projectedFiles: number;
	skills: number;
	warnings: string[];
}

export interface AgentSyncResumeResult {
	agentId: string | null;
	conversationId: string;
	mode: "load" | "replay" | string;
	nativeSessionId: string | null;
	reason: string;
	response: unknown;
}

export interface AgentSyncBinding {
	agentId: string;
	capabilities: unknown;
	conversationId: string;
	engine: string;
	nativeSessionId: string;
	nodeId: string;
	updatedAt: number;
	workingDirectory: string | null;
}

export interface AgentSyncStatus {
	activeOperations: number;
	bindings: AgentSyncBinding[];
	items: AgentSyncItemStatus[];
	nodeId: string;
	profiles: AgentSyncProfile[];
}

export interface AgentSyncItemStatus {
	conflict: unknown;
	generatedHash: string | null;
	kind: string;
	operationId: string | null;
	profileId: string;
	revision: number;
	sourceHash: string | null;
	sourceId: string;
	state: string;
	updatedAt: number;
}

function toImportOutcome(result: ImportOutcomeWire): ImportOutcome {
	return {
		alreadyExists: result.already_exists ?? false,
		detail: result.detail,
		folderPath: result.folder_path,
		id: result.id,
		kind: result.kind,
		status: result.status,
		title: result.title,
	};
}

interface ImportOutcomeWire {
	already_exists?: boolean;
	detail?: string;
	folder_path?: string;
	id: string;
	kind: ImportItemKind;
	status: "imported" | "skipped" | "failed";
	title: string;
}

function toImportResult(body: {
	conflicts?: number;
	dryRun?: boolean;
	failed?: number;
	imported?: number;
	operationId?: string;
	profileId?: string;
	results?: ImportOutcomeWire[];
	skipped?: number;
}): AgentSyncImportResult {
	return {
		conflicts: body.conflicts ?? 0,
		dryRun: body.dryRun ?? false,
		failed: body.failed ?? 0,
		imported: body.imported ?? 0,
		operationId: body.operationId ?? "unknown",
		profileId: body.profileId ?? "unknown",
		results: (body.results ?? []).map(toImportOutcome),
		skipped: body.skipped ?? 0,
	};
}

export function listAgentSyncProfiles(
	target: ApiTarget
): Promise<{ profiles: AgentSyncProfile[] }> {
	return request<{ profiles?: AgentSyncProfile[] }>(
		target,
		"/api/agent-sync/profiles",
		undefined,
		responseCodec1
	).then((body) => ({ profiles: body.profiles ?? [] }));
}

export function saveAgentSyncProfile(
	target: ApiTarget,
	input: AgentSyncProfileInput
): Promise<AgentSyncProfile> {
	return request<AgentSyncProfile>(
		target,
		"/api/agent-sync/profiles",
		{
			method: "POST",
			body: input,
		},
		agentSyncProfileResponseCodec
	);
}

export async function deleteAgentSyncProfile(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/agent-sync/profiles/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		responseCodec2
	);
}

export function scanAgentSyncRoot(
	target: ApiTarget,
	path: string,
	provider?: SyncProvider
): Promise<AgentSyncScan> {
	return request<AgentSyncScan>(
		target,
		"/api/agent-sync/scan",
		{
			method: "POST",
			body: { path, provider },
		},
		agentSyncScanResponseCodec
	);
}

export async function importAgentSyncThread(
	target: ApiTarget,
	input: { agentId: string; dryRun?: boolean; threadId: string }
): Promise<{
	alreadyImported: boolean;
	conversationId: string | null;
	dryRun: boolean;
	messagesAdded: number;
	wouldCreate: boolean;
}> {
	const body = await request<{
		already_imported?: boolean;
		conversation_id?: string;
		dry_run?: boolean;
		messages_added?: number;
		would_create?: boolean;
	}>(
		target,
		"/api/agent-sync/threads/import",
		{
			method: "POST",
			body: {
				agentId: input.agentId,
				dryRun: input.dryRun ?? false,
				threadId: input.threadId,
			},
		},
		responseCodec3
	);
	return {
		alreadyImported: body.already_imported ?? false,
		conversationId: body.conversation_id ?? null,
		dryRun: body.dry_run ?? false,
		messagesAdded: body.messages_added ?? 0,
		wouldCreate: body.would_create ?? false,
	};
}

export async function importAgentSyncItems(
	target: ApiTarget,
	input: {
		dryRun?: boolean;
		items: ImportSelection[];
		path?: string;
		profileId: string;
	}
): Promise<AgentSyncImportResult> {
	const body = await request<{
		conflicts?: number;
		dryRun?: boolean;
		failed?: number;
		imported?: number;
		operationId?: string;
		profileId?: string;
		results?: ImportOutcomeWire[];
		skipped?: number;
	}>(
		target,
		"/api/agent-sync/import",
		{
			method: "POST",
			body: {
				dryRun: input.dryRun ?? false,
				items: input.items,
				path: input.path,
				profileId: input.profileId,
			},
		},
		responseCodec4
	);
	return toImportResult(body);
}

export function exportAgentSyncBundle(
	target: ApiTarget,
	input: {
		destination: string;
		dryRun?: boolean;
		includeAgents?: boolean;
		includeConversations?: boolean;
		includeSkills?: boolean;
		profileId?: string;
	}
): Promise<AgentSyncExportResult> {
	return request<AgentSyncExportResult>(
		target,
		"/api/agent-sync/export",
		{
			method: "POST",
			body: {
				destination: input.destination,
				dryRun: input.dryRun ?? false,
				includeAgents: input.includeAgents ?? true,
				includeConversations: input.includeConversations ?? true,
				includeSkills: input.includeSkills ?? true,
				profileId: input.profileId,
			},
		},
		agentSyncExportResultResponseCodec
	);
}

export function resumeAgentSyncAcpSession(
	target: ApiTarget,
	conversationId: string
): Promise<AgentSyncResumeResult> {
	return request<AgentSyncResumeResult>(
		target,
		"/api/agent-sync/acp/resume",
		{
			method: "POST",
			body: { conversationId },
		},
		agentSyncResumeResultResponseCodec
	);
}

export function getAgentSyncStatus(
	target: ApiTarget
): Promise<AgentSyncStatus> {
	return request<AgentSyncStatus>(
		target,
		"/api/agent-sync/status",
		undefined,
		agentSyncStatusResponseCodec
	);
}

export function resolveAgentSyncConflict(
	target: ApiTarget,
	input: {
		itemId: string;
		kind: string;
		profileId: string;
		resolution: "keep_external" | "keep_ryu";
	}
): Promise<{ resolved: boolean }> {
	return request<{ resolved: boolean }>(
		target,
		"/api/agent-sync/conflicts/resolve",
		{
			method: "PUT",
			body: {
				itemId: input.itemId,
				kind: input.kind,
				profileId: input.profileId,
				resolution: input.resolution,
			},
		},
		responseCodec5
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const syncProviderResponseCodec = z.enum(SYNC_PROVIDERS);
const agentSyncProfileResponseCodec = z
	.object({
		conflictCount: z.number(),
		exportEnabled: z.boolean(),
		id: z.string(),
		importEnabled: z.boolean(),
		lastOperationId: z.union([z.string(), z.null()]),
		provider: syncProviderResponseCodec,
		root: z.string(),
		status: z.string(),
		updatedAt: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z
	.object({ profiles: z.array(agentSyncProfileResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const agentSyncCapabilitiesResponseCodec = z
	.object({
		acpLoadResume: z.union([z.boolean(), z.null()]),
		nativeConversationExport: z.boolean(),
		nativeThreads: z.boolean(),
		note: z.union([z.string(), z.null()]),
		portableBundle: z.boolean(),
		setupImport: z.boolean(),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncScanItemResponseCodec = z
	.object({
		already_exists: z.boolean().optional(),
		detail: z.string().optional(),
		id: z.string(),
		kind: importItemKindSchema,
		title: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const nativeThreadResponseCodec = z
	.object({
		cwd: z.string().optional(),
		engine: z.string(),
		git_branch: z.string().optional(),
		id: z.string(),
		message_count: z.number(),
		native_session_id: z.string().optional(),
		title: z.string(),
		updated_at: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncScanResponseCodec = z
	.object({
		agentId: z.union([z.string(), z.null()]),
		capabilities: agentSyncCapabilitiesResponseCodec,
		items: z.array(agentSyncScanItemResponseCodec),
		provider: syncProviderResponseCodec,
		root: z.string(),
		threads: z.array(nativeThreadResponseCodec),
		warnings: z.array(z.string()),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec3 = z
	.object({
		already_imported: z.boolean().optional(),
		conversation_id: z.string().optional(),
		dry_run: z.boolean().optional(),
		messages_added: z.number().optional(),
		would_create: z.boolean().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const importOutcomeWireResponseCodec = z
	.object({
		already_exists: z.boolean().optional(),
		detail: z.string().optional(),
		folder_path: z.string().optional(),
		id: z.string(),
		kind: importItemKindSchema,
		status: z.union([
			z.literal("imported"),
			z.literal("skipped"),
			z.literal("failed"),
		]),
		title: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec4 = z
	.object({
		conflicts: z.number().optional(),
		dryRun: z.boolean().optional(),
		failed: z.number().optional(),
		imported: z.number().optional(),
		operationId: z.string().optional(),
		profileId: z.string().optional(),
		results: z.array(importOutcomeWireResponseCodec).optional(),
		skipped: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const acpResumeStatusResponseCodec = z
	.object({
		agentId: z.union([z.string(), z.null()]),
		conversationId: z.string(),
		mode: z.string(),
		reason: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncExportResultResponseCodec = z
	.object({
		acpResume: z.array(acpResumeStatusResponseCodec),
		agents: z.number(),
		bundleHash: z.string(),
		bundlePath: z.string(),
		conflicts: z.number(),
		conversations: z.number(),
		destination: z.string(),
		dryRun: z.boolean(),
		messages: z.number(),
		operationId: z.string(),
		profileId: z.union([z.string(), z.null()]),
		projectedFiles: z.number(),
		skills: z.number(),
		warnings: z.array(z.string()),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncResumeResultResponseCodec = z
	.object({
		agentId: z.union([z.string(), z.null()]),
		conversationId: z.string(),
		mode: z.string(),
		nativeSessionId: z.union([z.string(), z.null()]),
		reason: z.string(),
		response: gatewayJsonValueSchema,
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncBindingResponseCodec = z
	.object({
		agentId: z.string(),
		capabilities: gatewayJsonValueSchema,
		conversationId: z.string(),
		engine: z.string(),
		nativeSessionId: z.string(),
		nodeId: z.string(),
		updatedAt: z.number(),
		workingDirectory: z.union([z.string(), z.null()]),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncItemStatusResponseCodec = z
	.object({
		conflict: gatewayJsonValueSchema,
		generatedHash: z.union([z.string(), z.null()]),
		kind: z.string(),
		operationId: z.union([z.string(), z.null()]),
		profileId: z.string(),
		revision: z.number(),
		sourceHash: z.union([z.string(), z.null()]),
		sourceId: z.string(),
		state: z.string(),
		updatedAt: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const agentSyncStatusResponseCodec = z
	.object({
		activeOperations: z.number(),
		bindings: z.array(agentSyncBindingResponseCodec),
		items: z.array(agentSyncItemStatusResponseCodec),
		nodeId: z.string(),
		profiles: z.array(agentSyncProfileResponseCodec),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec5 = z
	.object({ resolved: z.boolean() })
	.catchall(gatewayJsonValueSchema);
