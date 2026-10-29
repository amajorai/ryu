import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/mission-control.ts
//
// Typed client for the `@ryu/mission-control` sidecar, plus the indexer that
// keeps it current.
//
// Data path: `/api/mission-control/*` DIRECTLY. The app's manifest declares
// `http.public_mount`, so Core mounts the sidecar at that prefix and the longer
// `/api/ext/@ryu/mission-control/*` form is not needed. Every path used below
// must also appear in the manifest's `http.routes[]` — Core's ext-proxy 404s an
// undeclared path before it ever reaches the sidecar.
//
// THE INDEXER IS HERE, NOT IN THE SIDECAR, and that is forced rather than
// chosen: a manifest sidecar's callbacks into Core are `model/complete`, `rpc`
// and `capability/:cap` — none of which reads a conversation — and the `parts`
// column those digests come from is sealed at rest. The desktop already holds
// every message with its tool calls, so it derives the digest with the same
// `buildMissionDigest` the in-chat panel renders from and PUTs the result. That
// shared function is what makes the panel and the dashboard agree about a chat.

import {
	buildMissionDigest,
	type MissionStreamMessage,
} from "@/src/lib/mission-control/turn-groups.ts";
import { type ApiTarget, request } from "./client.ts";

/** The app's manifest id. Must match Core's
 *  `plugins::builtins::MISSION_CONTROL_PLUGIN_ID`. */
export const MISSION_CONTROL_PLUGIN_ID = "@ryu/mission-control";

/** The id of the app's sidebar button whose `target` the page mounts at. The id
 *  is the stable join key; the target is the part the app may move. */
export const MISSION_CONTROL_BUTTON_ID = "home";

/** The path the manifest currently declares. A cold-start default for callers
 *  that cannot read the live contributions feed — never a second source of
 *  truth (see `useAppShellPath`). */
export const MISSION_CONTROL_DEFAULT_PATH = "/mission-control";

const BASE = "/api/mission-control";

// ── wire shapes (snake_case, mirroring the Rust structs) ──────────────────────

export interface MissionTotalsWire {
	commands: number;
	failures: number;
	files_touched: number;
	tool_calls: number;
	turns: number;
	writes: number;
}

export interface MissionFileWire {
	count: number;
	kind: string;
	path: string;
}

export interface MissionTurnWire {
	files: MissionFileWire[];
	headline: string;
	index: number;
	outcome: string;
	rationale: string;
	request: string;
	status: string;
}

export interface MissionWorkItemWire {
	content: string;
	status: string;
}

export interface MissionConversationDigest {
	agent_id: string | null;
	conversation_id: string;
	done_count: number;
	folder_path: string | null;
	headline: string | null;
	indexed_at: number;
	open_count: number;
	source_updated_at: number;
	summarized_at: number | null;
	summary: string | null;
	title: string | null;
	totals: MissionTotalsWire;
}

export interface MissionConversationDetail extends MissionConversationDigest {
	done_items: MissionWorkItemWire[];
	files: MissionFileWire[];
	open_items: MissionWorkItemWire[];
	turns: MissionTurnWire[];
}

export interface MissionDayBucket {
	conversations: number;
	date: string;
	failures: number;
	turns: number;
	writes: number;
}

export interface MissionOpenItem {
	content: string;
	conversation_id: string;
	conversation_title: string | null;
	folder_path: string | null;
	source_updated_at: number;
	status: string;
}

export interface MissionHotFile {
	conversations: number;
	kind: string;
	path: string;
	touches: number;
}

export interface MissionOverview {
	conversations: MissionConversationDigest[];
	days: MissionDayBucket[];
	files: MissionHotFile[];
	folder_path: string | null;
	open_items: MissionOpenItem[];
	since_ms: number | null;
	totals: MissionTotalsWire & {
		conversations: number;
		open_items: number;
	};
}

interface IndexStateRow {
	conversation_id: string;
	source_updated_at: number;
	summarized: boolean;
}

// ── reads ─────────────────────────────────────────────────────────────────────

export interface MissionWindow {
	days?: number;
	folderPath?: string | null;
	limit?: number;
}

function windowQuery(window: MissionWindow): string {
	const params = new URLSearchParams();
	if (window.days !== undefined) {
		params.set("days", String(window.days));
	}
	if (window.folderPath) {
		params.set("folder_path", window.folderPath);
	}
	if (window.limit !== undefined) {
		params.set("limit", String(window.limit));
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

export function getMissionOverview(
	target: ApiTarget,
	window: MissionWindow,
	signal?: AbortSignal
): Promise<MissionOverview> {
	return request<MissionOverview>(
		target,
		`${BASE}/overview${windowQuery(window)}`,
		{ signal },
		missionOverviewResponseSchema
	);
}

export function getMissionConversation(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<MissionConversationDetail> {
	return request<MissionConversationDetail>(
		target,
		`${BASE}/conversations/${encodeURIComponent(conversationId)}`,
		{ signal },
		missionConversationDetailResponseSchema
	);
}

export function summarizeMissionConversation(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<{ summarized_at: number; summary: string }> {
	return request(
		target,
		`${BASE}/conversations/${encodeURIComponent(conversationId)}/summarize`,
		{ method: "POST", signal },
		summarizeMissionConversationResponseSchema
	);
}

export function forgetMissionConversation(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<{ removed: boolean }> {
	return request(
		target,
		`${BASE}/conversations/${encodeURIComponent(conversationId)}`,
		{ method: "DELETE", signal },
		forgetMissionConversationResponseSchema
	);
}

// ── indexing ──────────────────────────────────────────────────────────────────

/** Core's `GET /api/conversations` row, narrowed to what indexing needs. */
interface CoreConversationSummary {
	agent_id: string | null;
	archived?: boolean;
	folder_path: string | null;
	id: string;
	message_count: number;
	title: string | null;
	updated_at: number;
}

interface CoreConversationDetail {
	messages?: MissionStreamMessage[];
}

/**
 * How many stale conversations one sync pass will fetch and index.
 *
 * A bound, not a page size: each miss costs a full conversation read, and the
 * dashboard is a glance, not an archive. A first run over a large history
 * therefore fills in over several refreshes rather than stalling on one — and
 * {@link syncMissionIndex} reports what it left, so the page can say so instead
 * of quietly implying it covered everything.
 */
export const MAX_INDEX_PER_SYNC = 25;

export interface MissionSyncResult {
	/** Conversations that were stale but not reached under the cap this pass. */
	deferred: number;
	/** Conversations whose digest was (re)written. */
	indexed: number;
	/** Conversations that were already current. */
	skipped: number;
}

/** Empty digests are not worth a row: a chat with no assistant turns has nothing
 *  to show on a dashboard, and indexing it would pad every count. */
function isWorthIndexing(
	digest: ReturnType<typeof buildMissionDigest>
): boolean {
	return digest.turns.length > 0;
}

async function indexOne(
	target: ApiTarget,
	summary: CoreConversationSummary,
	signal?: AbortSignal
): Promise<boolean> {
	const detail = await request<CoreConversationDetail>(
		target,
		`/api/conversations/${encodeURIComponent(summary.id)}`,
		{ signal },
		coreConversationDetailResponseSchema
	);
	const digest = buildMissionDigest(detail.messages ?? []);
	if (!isWorthIndexing(digest)) {
		return false;
	}
	await request(
		target,
		`${BASE}/conversations/${encodeURIComponent(summary.id)}`,
		{
			method: "PUT",
			signal,
			body: {
				title: summary.title,
				folder_path: summary.folder_path,
				agent_id: summary.agent_id,
				source_updated_at: summary.updated_at,
				totals: {
					turns: digest.totals.turns,
					writes: digest.totals.writes,
					commands: digest.totals.commands,
					failures: digest.totals.failures,
					tool_calls: digest.totals.toolCalls,
					files_touched: digest.totals.filesTouched,
				},
				turns: digest.turns.map((turn) => ({
					index: turn.index,
					headline: turn.headline,
					request: turn.request,
					rationale: turn.rationale,
					outcome: turn.outcome,
					status: turn.status,
					files: turn.files,
				})),
				files: digest.files,
				open_items: digest.openTodos,
				done_items: digest.doneTodos,
			},
		},
		indexOneResponseSchema
	);
	return true;
}

/**
 * Bring the sidecar's index up to date with Core's conversations.
 *
 * Staleness is decided by Core's `updated_at` against the stored
 * `source_updated_at`, so a refresh over a hundred chats costs two list requests
 * plus one read per chat that actually moved — normally none. Archived chats and
 * chats with no messages are skipped outright.
 *
 * A single conversation that fails to index does NOT fail the pass: one
 * unreadable chat must not blank the whole dashboard.
 */
export async function syncMissionIndex(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<MissionSyncResult> {
	const [list, state] = await Promise.all([
		request<{ conversations: CoreConversationSummary[] }>(
			target,
			"/api/conversations",
			{ signal },
			syncMissionIndexResponseSchema
		),
		request<{ conversations: IndexStateRow[] }>(
			target,
			`${BASE}/index-state`,
			{
				signal,
			},
			syncMissionIndexResponseSchema8
		),
	]);

	const stored = new Map(
		state.conversations.map((row) => [
			row.conversation_id,
			row.source_updated_at,
		])
	);

	const stale: CoreConversationSummary[] = [];
	let skipped = 0;
	for (const summary of list.conversations) {
		if (summary.archived || summary.message_count === 0) {
			continue;
		}
		if (stored.get(summary.id) === summary.updated_at) {
			skipped += 1;
			continue;
		}
		stale.push(summary);
	}

	// Newest first, so a capped pass indexes what the user is most likely looking
	// for rather than whatever the list happened to start with.
	stale.sort((a, b) => b.updated_at - a.updated_at);
	const batch = stale.slice(0, MAX_INDEX_PER_SYNC);

	let indexed = 0;
	for (const summary of batch) {
		try {
			if (await indexOne(target, summary, signal)) {
				indexed += 1;
			}
		} catch (err) {
			if (signal?.aborted) {
				throw err;
			}
			// Deliberately swallowed per-conversation: see the doc comment.
		}
	}

	return { deferred: stale.length - batch.length, indexed, skipped };
}

const missionOverviewResponseSchema: z.ZodType<MissionOverview> =
	retainValidatedResponse(
		z
			.object({
				conversations: z.array(
					z
						.object({
							agent_id: z.union([z.string(), z.null()]),
							conversation_id: z.string(),
							done_count: z.number(),
							folder_path: z.union([z.string(), z.null()]),
							headline: z.union([z.string(), z.null()]),
							indexed_at: z.number(),
							open_count: z.number(),
							source_updated_at: z.number(),
							summarized_at: z.union([z.number(), z.null()]),
							summary: z.union([z.string(), z.null()]),
							title: z.union([z.string(), z.null()]),
							totals: z
								.object({
									commands: z.number(),
									failures: z.number(),
									files_touched: z.number(),
									tool_calls: z.number(),
									turns: z.number(),
									writes: z.number(),
								})
								.passthrough(),
						})
						.passthrough()
				),
				days: z.array(
					z
						.object({
							conversations: z.number(),
							date: z.string(),
							failures: z.number(),
							turns: z.number(),
							writes: z.number(),
						})
						.passthrough()
				),
				files: z.array(
					z
						.object({
							conversations: z.number(),
							kind: z.string(),
							path: z.string(),
							touches: z.number(),
						})
						.passthrough()
				),
				folder_path: z.union([z.string(), z.null()]),
				open_items: z.array(
					z
						.object({
							content: z.string(),
							conversation_id: z.string(),
							conversation_title: z.union([z.string(), z.null()]),
							folder_path: z.union([z.string(), z.null()]),
							source_updated_at: z.number(),
							status: z.string(),
						})
						.passthrough()
				),
				since_ms: z.union([z.number(), z.null()]),
				totals: z
					.object({
						commands: z.number(),
						failures: z.number(),
						files_touched: z.number(),
						tool_calls: z.number(),
						turns: z.number(),
						writes: z.number(),
						conversations: z.number(),
						open_items: z.number(),
					})
					.passthrough(),
			})
			.passthrough()
	);
const missionConversationDetailResponseSchema: z.ZodType<MissionConversationDetail> =
	retainValidatedResponse(
		z
			.object({
				done_items: z.array(
					z.object({ content: z.string(), status: z.string() }).passthrough()
				),
				files: z.array(
					z
						.object({ count: z.number(), kind: z.string(), path: z.string() })
						.passthrough()
				),
				open_items: z.array(
					z.object({ content: z.string(), status: z.string() }).passthrough()
				),
				turns: z.array(
					z
						.object({
							files: z.array(
								z
									.object({
										count: z.number(),
										kind: z.string(),
										path: z.string(),
									})
									.passthrough()
							),
							headline: z.string(),
							index: z.number(),
							outcome: z.string(),
							rationale: z.string(),
							request: z.string(),
							status: z.string(),
						})
						.passthrough()
				),
				agent_id: z.union([z.string(), z.null()]),
				conversation_id: z.string(),
				done_count: z.number(),
				folder_path: z.union([z.string(), z.null()]),
				headline: z.union([z.string(), z.null()]),
				indexed_at: z.number(),
				open_count: z.number(),
				source_updated_at: z.number(),
				summarized_at: z.union([z.number(), z.null()]),
				summary: z.union([z.string(), z.null()]),
				title: z.union([z.string(), z.null()]),
				totals: z
					.object({
						commands: z.number(),
						failures: z.number(),
						files_touched: z.number(),
						tool_calls: z.number(),
						turns: z.number(),
						writes: z.number(),
					})
					.passthrough(),
			})
			.passthrough()
	);
const summarizeMissionConversationResponseSchema: z.ZodType<{
	summarized_at: number;
	summary: string;
}> = retainValidatedResponse(
	z.object({ summarized_at: z.number(), summary: z.string() }).passthrough()
);
const forgetMissionConversationResponseSchema: z.ZodType<{ removed: boolean }> =
	retainValidatedResponse(z.object({ removed: z.boolean() }).passthrough());
const coreConversationDetailResponseSchema: z.ZodType<CoreConversationDetail> =
	retainValidatedResponse(
		z
			.object({
				messages: z
					.array(
						z
							.object({
								id: z.string().optional(),
								parts: z
									.array(
										z
											.object({
												input: gatewayJsonValueSchema.optional(),
												output: gatewayJsonValueSchema.optional(),
												state: z.string().optional(),
												text: gatewayJsonValueSchema.optional(),
												toolCallId: z.string().optional(),
												toolName: z.string().optional(),
												type: z.string().optional(),
											})
											.passthrough()
									)
									.optional(),
								role: z.string().optional(),
							})
							.passthrough()
					)
					.optional(),
			})
			.passthrough()
	);
const indexOneResponseSchema: z.ZodType<boolean> = retainValidatedResponse(
	z.boolean()
);
const syncMissionIndexResponseSchema: z.ZodType<{
	conversations: CoreConversationSummary[];
}> = retainValidatedResponse(
	z
		.object({
			conversations: z.array(
				z
					.object({
						agent_id: z.union([z.string(), z.null()]),
						archived: z.boolean().optional(),
						folder_path: z.union([z.string(), z.null()]),
						id: z.string(),
						message_count: z.number(),
						title: z.union([z.string(), z.null()]),
						updated_at: z.number(),
					})
					.passthrough()
			),
		})
		.passthrough()
);
const syncMissionIndexResponseSchema8: z.ZodType<{
	conversations: IndexStateRow[];
}> = retainValidatedResponse(
	z
		.object({
			conversations: z.array(
				z
					.object({
						conversation_id: z.string(),
						source_updated_at: z.number(),
						summarized: z.boolean(),
					})
					.passthrough()
			),
		})
		.passthrough()
);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
