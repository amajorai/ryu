// packages/core-client/src/vault-events.ts
//
// Subscriber for Core's value-free vault change stream (`GET /api/vault/events`
// for a person on the node bearer, `GET /api/vault/agent/events` for a machine
// vault token). Core delivers each event only when the caller holds `list` on
// its policy key, and an event carries coordinates only: type, environment,
// path, name, version, and lease id. It never carries a value.
//
// `ryu secrets run --watch` restarts its command when one of these arrives.

import { z } from "zod";
import {
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import { VAULT_TOKEN_HEADER, type VaultAgentTarget } from "./vault.ts";

/** One value-free vault change. */
export interface VaultChangeEvent {
	action: string;
	at: string;
	environment?: string;
	leaseId?: string;
	name?: string;
	path?: string;
	seq: number;
	/** e.g. `kv-write`, `kv-delete`, `kv-destroy`, `lease-revoke`, `lease-expire`. */
	type: string;
	version?: number;
}

/** What a subscriber receives: a change, or notice that it fell behind and
 *  skipped `skipped` events (refetch rather than trust local state). */
export type VaultEventMessage =
	| { event: VaultChangeEvent; kind: "event" }
	| { kind: "lagged"; skipped: number };

export interface VaultEventFilter {
	environment?: string;
	/** Policy-key glob such as `prod/payments/*`. */
	path?: string;
	/** Event types; all when omitted. */
	types?: string[];
}

const vaultChangeEventSchema = z.object({
	action: z.string(),
	at: z.string(),
	environment: z.string().optional(),
	leaseId: z.string().optional(),
	name: z.string().optional(),
	path: z.string().optional(),
	seq: z.number().int(),
	type: z.string(),
	version: z.number().int().optional(),
});

const laggedSchema = z.object({ skipped: z.number().int().nonnegative() });

/** Parse one SSE frame (the text between blank lines) into a message, or
 *  null for keep-alives, comments, and frames that are not vault events. */
export function parseVaultEventFrame(frame: string): VaultEventMessage | null {
	let name = "message";
	const data: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) {
			name = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice(5).trimStart());
		}
	}
	if (data.length === 0) {
		return null;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(data.join("\n"));
	} catch {
		return null;
	}
	if (name === "lagged") {
		const lagged = laggedSchema.safeParse(payload);
		return lagged.success
			? { kind: "lagged", skipped: lagged.data.skipped }
			: null;
	}
	if (name !== "vault") {
		return null;
	}
	const event = vaultChangeEventSchema.safeParse(payload);
	return event.success ? { kind: "event", event: event.data } : null;
}

function eventQuery(filter: VaultEventFilter): string {
	const params = new URLSearchParams();
	if (filter.types && filter.types.length > 0) {
		params.set("types", filter.types.join(","));
	}
	if (filter.environment) {
		params.set("environment", filter.environment);
	}
	if (filter.path) {
		params.set("path", filter.path);
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

async function* readFrames(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<VaultEventMessage> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.search(/\r?\n\r?\n/);
			while (boundary >= 0) {
				const separator =
					buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
				const message = parseVaultEventFrame(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + separator.length);
				if (message) {
					yield message;
				}
				boundary = buffer.search(/\r?\n\r?\n/);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function open(
	url: string,
	path: string,
	fetcher: ReturnType<typeof fetchForTarget>,
	headers: Record<string, string>,
	signal: AbortSignal | undefined
): Promise<ReadableStream<Uint8Array>> {
	const response = await fetcher(url, {
		headers: { ...headers, Accept: "text/event-stream" },
		signal,
	});
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, await response.text());
	}
	if (!response.body) {
		throw apiErrorFromBody(path, response.status, "");
	}
	return response.body;
}

/** Subscribe to vault changes for a person (node bearer plus optional user
 *  JWT). Resolves once Core accepted the subscription and throws an
 *  `ApiError` when it refused, so a caller knows it is watching before it
 *  acts. The stream ends when Core closes it (for example when the caller's
 *  access is revoked) or `signal` aborts. */
export async function openVaultEventStream(
	target: ApiTarget,
	filter: VaultEventFilter = {},
	signal?: AbortSignal
): Promise<AsyncGenerator<VaultEventMessage>> {
	const path = `/api/vault/events${eventQuery(filter)}`;
	const body = await open(
		apiUrl(target, path),
		"/api/vault/events",
		fetchForTarget(target),
		{ ...makeHeaders(target.token, target.userJwt) },
		signal
	);
	return readFrames(body);
}

/** {@link openVaultEventStream} for a machine vault token. Sends only the
 *  token header, never a node bearer. */
export async function openVaultAgentEventStream(
	target: VaultAgentTarget,
	filter: VaultEventFilter = {},
	signal?: AbortSignal
): Promise<AsyncGenerator<VaultEventMessage>> {
	const path = `/api/vault/agent/events${eventQuery(filter)}`;
	const base = target.url.replace(/\/$/, "");
	const body = await open(
		`${base}${path}`,
		"/api/vault/agent/events",
		fetchForTarget(target),
		{ [VAULT_TOKEN_HEADER]: target.vaultToken },
		signal
	);
	return readFrames(body);
}

/** Stream vault changes for a person; see {@link openVaultEventStream}. */
export async function* streamVaultEvents(
	target: ApiTarget,
	filter: VaultEventFilter = {},
	signal?: AbortSignal
): AsyncGenerator<VaultEventMessage> {
	yield* await openVaultEventStream(target, filter, signal);
}

/** Stream vault changes for a machine vault token. */
export async function* streamVaultAgentEvents(
	target: VaultAgentTarget,
	filter: VaultEventFilter = {},
	signal?: AbortSignal
): AsyncGenerator<VaultEventMessage> {
	yield* await openVaultAgentEventStream(target, filter, signal);
}
