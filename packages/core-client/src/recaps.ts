// Typed client for Ryu Recaps, served by the `@ryu/meetings` app satellite and
// reached through Core's generic ext-proxy at `/api/ext/@ryu/meetings/recaps`.
//
// Every route is owner scoped: Core stamps the verified caller and the sidecar
// answers 404 for another member's recap. Search is a POST so queries never land
// in URLs or access logs. Chunk uploads send raw audio bytes (not JSON), and
// finalize reports missing chunks as data rather than an error.

import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";
import type {
	Recap,
	RecapChunkResult,
	RecapDigest,
	RecapNotes,
	RecapSearchResult,
	RecapSettings,
	RecapSource,
} from "./recaps-schemas.ts";
import {
	chunkResultSchema,
	chunkStatusSchema,
	detailSchema,
	digestEnvelopeSchema,
	envelopeSchema,
	interimViewSchema,
	listSchema,
	okSchema,
	searchSchema,
	settingsViewSchema,
	startResponseSchema,
} from "./recaps-schemas.ts";

export type {
	Recap,
	RecapChunkResult,
	RecapDigest,
	RecapInterim,
	RecapInterimView,
	RecapNotes,
	RecapSearchResult,
	RecapSettings,
	RecapSettingsView,
	RecapSource,
	RecapUploadContract,
} from "./recaps-schemas.ts";
export {
	recapActionItemSchema,
	recapDigestSchema,
	recapInterimSchema,
	recapMetaSchema,
	recapNotesSchema,
	recapSchema,
	recapSettingsSchema,
	recapUploadContractSchema,
} from "./recaps-schemas.ts";

/** The ext-proxy base every recap route lives under. */
export const RECAPS_BASE = "/api/ext/@ryu/meetings/recaps";

/** The server's machine error code (`consent_required`, `recap_unconfirmed`, …). */
export function recapErrorCode(error: unknown): string | undefined {
	return error instanceof ApiError ? error.serverMessage : undefined;
}

function itemPath(id: string, suffix: string): string {
	return `${RECAPS_BASE}/${encodeURIComponent(id)}${suffix}`;
}

export interface StartRecapInput {
	/** The client's idempotency key (a UUID); replays return the same recap. */
	clientSessionId: string;
	consentVersion: number;
	/** True when the start bypassed the in-app acknowledgement. */
	fastPath?: boolean;
	localDay: string;
	locale?: string;
	source: RecapSource;
	tz: string;
}

export function startRecap(target: ApiTarget, input: StartRecapInput) {
	return request(
		target,
		RECAPS_BASE,
		{
			body: {
				client_session_id: input.clientSessionId,
				consent_version: input.consentVersion,
				fast_path: input.fastPath ?? false,
				local_day: input.localDay,
				locale: input.locale,
				source: input.source,
				tz: input.tz,
			},
			method: "POST",
		},
		startResponseSchema
	);
}

export async function confirmRecap(
	target: ApiTarget,
	id: string
): Promise<Recap> {
	const json = await request(
		target,
		itemPath(id, "/confirm"),
		{ method: "POST" },
		envelopeSchema
	);
	return json.recap;
}

export interface RecapChunk {
	body: BodyInit;
	contentType: string;
	durationMs: number;
	offsetMs: number;
	seq: number;
	/** Optional client digest; the server rejects a mismatch. */
	sha256?: string;
}

/** Upload one audio chunk; replaying the same bytes answers `duplicate: true`. */
export function uploadRecapChunk(
	target: ApiTarget,
	id: string,
	chunk: RecapChunk
): Promise<RecapChunkResult> {
	return putChunk(
		target,
		id,
		chunk.seq,
		{
			"Content-Type": chunk.contentType,
			"x-recap-duration-ms": String(chunk.durationMs),
			"x-recap-offset-ms": String(chunk.offsetMs),
			...(chunk.sha256 ? { "x-recap-sha256": chunk.sha256 } : {}),
		},
		chunk.body
	);
}

/** Record a chunk the device's VAD found silent, without sending audio. */
export function markRecapChunkSilent(
	target: ApiTarget,
	id: string,
	chunk: Pick<RecapChunk, "durationMs" | "offsetMs" | "seq">
): Promise<RecapChunkResult> {
	return putChunk(
		target,
		id,
		chunk.seq,
		{
			"x-recap-duration-ms": String(chunk.durationMs),
			"x-recap-offset-ms": String(chunk.offsetMs),
			"x-recap-silent": "1",
		},
		""
	);
}

async function putChunk(
	target: ApiTarget,
	id: string,
	seq: number,
	headers: Record<string, string>,
	body: BodyInit
): Promise<RecapChunkResult> {
	const path = itemPath(id, `/chunks/${seq}`);
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		body,
		headers: { ...makeHeaders(target.token, target.userJwt), ...headers },
		method: "PUT",
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw apiErrorFromBody(path, resp.status, text);
	}
	return chunkResultSchema.parse(JSON.parse(text));
}

export function getRecapChunkStatus(target: ApiTarget, id: string) {
	return request(target, itemPath(id, "/chunks"), {}, chunkStatusSchema);
}

export type FinalizeRecapResult =
	| { kind: "accepted"; recap: Recap }
	| { kind: "missing"; missing: number[] };

const missingSchema = z.object({
	error: z.literal("missing_chunks"),
	missing: z.array(z.number()),
});

/** Finalize; a 409 listing missing chunks comes back as `{ kind: "missing" }`. */
export async function finalizeRecap(
	target: ApiTarget,
	id: string,
	input: { endedAt?: string; expectedChunks: number; force?: boolean }
): Promise<FinalizeRecapResult> {
	const path = itemPath(id, "/finalize");
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		body: JSON.stringify({
			ended_at: input.endedAt,
			expected_chunks: input.expectedChunks,
			force: input.force ?? false,
		}),
		headers: makeHeaders(target.token, target.userJwt),
		method: "POST",
	});
	const text = await resp.text();
	if (resp.status === 409) {
		const missing = missingSchema.safeParse(text ? JSON.parse(text) : null);
		if (missing.success) {
			return { kind: "missing", missing: missing.data.missing };
		}
	}
	if (!resp.ok) {
		throw apiErrorFromBody(path, resp.status, text);
	}
	return {
		kind: "accepted",
		recap: envelopeSchema.parse(JSON.parse(text)).recap,
	};
}

/**
 * The opt-in rolling summary of a recap that is still recording. `interim` is
 * null until enough speech was captured. The server keeps it in memory only and
 * drops it on finalize or delete. Errors carry `interim_disabled` (403, the
 * member's `interim` setting is off), `recap_not_recording` (409),
 * `consent_required` (409) or `rate_limited` (429) as {@link recapErrorCode}.
 */
export function getRecapInterim(target: ApiTarget, id: string) {
	return request(target, itemPath(id, "/interim"), {}, interimViewSchema);
}

/**
 * Whether a recap call failed because Core refused the caller's credential
 * (401): an expired session or an app-route delegation revoked after the member
 * was removed. Sign in again; do not retry with the same credential.
 */
export function recapNeedsSignIn(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

export interface ListRecapsQuery {
	cursor?: string;
	from?: string;
	limit?: number;
	to?: string;
}

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

export function listRecaps(target: ApiTarget, q: ListRecapsQuery = {}) {
	return request(target, `${RECAPS_BASE}${query({ ...q })}`, {}, listSchema);
}

export function getRecap(target: ApiTarget, id: string) {
	return request(target, itemPath(id, "/detail"), {}, detailSchema);
}

export async function updateRecap(
	target: ApiTarget,
	id: string,
	patch: { notes?: RecapNotes; pinned?: boolean; title?: string }
): Promise<Recap> {
	const json = await request(
		target,
		itemPath(id, "/detail"),
		{ body: patch, method: "PATCH" },
		envelopeSchema
	);
	return json.recap;
}

export async function deleteRecap(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		itemPath(id, "/detail"),
		{ method: "DELETE" },
		okSchema
	);
}

export async function deleteAllRecaps(target: ApiTarget): Promise<number> {
	const json = await request(
		target,
		RECAPS_BASE,
		{ method: "DELETE" },
		z.object({ removed: z.number() })
	);
	return json.removed;
}

/** The portable export: Markdown text, or the JSON document. */
export async function exportRecaps(
	target: ApiTarget,
	q: { format: "json" | "md"; from?: string; to?: string }
): Promise<string> {
	const path = `${RECAPS_BASE}/export${query({ ...q })}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw apiErrorFromBody(path, resp.status, text);
	}
	return text;
}

export function getRecapSettings(target: ApiTarget) {
	return request(target, `${RECAPS_BASE}/settings`, {}, settingsViewSchema);
}

export function updateRecapSettings(
	target: ApiTarget,
	patch: Partial<Omit<RecapSettings, "consent">>
) {
	return request(
		target,
		`${RECAPS_BASE}/settings`,
		{ body: patch, method: "PUT" },
		settingsViewSchema
	);
}

/** The node rollout switch (off by default). Node owner only: the route needs
 *  the `recaps.admin` level, and a member on a managed node gets 403
 *  `admin_required` (`settings.can_enable` says so in advance). */
export function setRecapsAvailability(target: ApiTarget, enabled: boolean) {
	return request(
		target,
		`${RECAPS_BASE}/availability`,
		{ body: { enabled }, method: "PUT" },
		z.object({ enabled: z.boolean() })
	);
}

export function giveRecapConsent(target: ApiTarget, version: number) {
	return request(
		target,
		`${RECAPS_BASE}/consent`,
		{ body: { version }, method: "POST" },
		settingsViewSchema
	);
}

export function withdrawRecapConsent(target: ApiTarget) {
	return request(
		target,
		`${RECAPS_BASE}/consent`,
		{ method: "DELETE" },
		z.object({
			/** Sessions still recording that withdrawal closed without a summary. */
			closed_recordings: z.number().default(0),
			recap_count: z.number(),
			withdrawn: z.literal(true),
		})
	);
}

export async function getDailyRecap(
	target: ApiTarget,
	date: string,
	tz: string
): Promise<RecapDigest | null> {
	const json = await request(
		target,
		`${RECAPS_BASE}/daily${query({ date, tz })}`,
		{},
		digestEnvelopeSchema
	);
	return json.digest;
}

export async function regenerateDailyRecap(
	target: ApiTarget,
	date: string,
	tz: string
): Promise<RecapDigest | null> {
	const json = await request(
		target,
		`${RECAPS_BASE}/daily/regenerate`,
		{ body: { date, tz }, method: "POST" },
		digestEnvelopeSchema
	);
	return json.digest;
}

export async function searchRecaps(
	target: ApiTarget,
	input: {
		from?: string;
		limit?: number;
		q: string;
		scope?: "notes" | "transcript";
		to?: string;
	}
): Promise<RecapSearchResult[]> {
	const json = await request(
		target,
		`${RECAPS_BASE}/search`,
		{ body: input, method: "POST" },
		searchSchema
	);
	return json.results;
}
