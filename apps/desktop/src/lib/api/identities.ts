// apps/desktop/src/lib/api/identities.ts
//
// Typed client for the Core Identity Vault API (`/api/identities/*`). Field names
// are snake_case to match Core's serde shapes exactly (see
// `apps/core/src/server/identity_api.rs` + `apps/core/src/identity/`). All logic —
// encryption, the CredentialSource seam, the health loop, agent binding — lives in
// Core; this is a thin transport layer over the shared {@link request} plumbing.
//
// Hard invariant (mirrored from Core, spec §6): no response body ever carries the
// sealed `encrypted_state` or any decrypted credential, so nothing here ever reads
// or surfaces credential material — only status.

import { type ApiTarget, request } from "./client.ts";

/** Durable authentication state of a connection. */
export type ConnectionStatus = "AUTHENTICATED" | "NEEDS_AUTH";

/** Transient login-flow position of a connection. */
export type FlowStatus = "IDLE" | "IN_PROGRESS" | "DONE" | "FAILED";

/** A single per-domain login belonging to a profile. The sealed credential state
 *  is structurally absent (Core `#[serde(skip)]`s it). */
export interface Connection {
	created_at: number;
	domain: string;
	flow_status: FlowStatus;
	id: string;
	last_checked: number;
	profile_id: string;
	source: string;
	status: ConnectionStatus;
	updated_at: number;
}

/** A profile groups many per-domain connections under one `profile_id`. An agent
 *  bound to a profile is "logged in to every connected domain" at once. */
export interface Profile {
	connections: Connection[];
	profile_id: string;
}

/** The started login flow shape returned by `POST .../:id/login`. `kind` is
 *  double-nested to match Core's hand-built wire envelope. */
export interface LoginFlow {
	flow_id: string;
	kind: { kind: "hosted"; url: string } | { kind: "manual" };
}

/** Poll result for a single connection. The top-level `status`/`flow_status` are
 *  the badge source; `connection` carries the full (leak-safe) record. */
export interface ConnectionPoll {
	connection: Connection;
	flow_status: FlowStatus;
	status: ConnectionStatus;
}

/** Fields needed to create a connection. `profile_id` is the user-named grouping
 *  key — a profile exists only once a connection carries it. */
export interface CreateConnectionInput {
	domain: string;
	profile_id: string;
	source?: string;
}

export async function listIdentities(target: ApiTarget): Promise<Profile[]> {
	const json = await request<{ profiles?: Profile[] }>(
		target,
		"/api/identities"
	);
	return json.profiles ?? [];
}

export async function createConnection(
	target: ApiTarget,
	input: CreateConnectionInput
): Promise<Connection> {
	const json = await request<{ connection?: Connection; error?: string }>(
		target,
		"/api/identities/connections",
		{ method: "POST", body: input }
	);
	if (!json.connection) {
		throw new Error(json.error ?? "failed to create connection");
	}
	return json.connection;
}

export async function beginLogin(
	target: ApiTarget,
	id: string
): Promise<LoginFlow> {
	return await request<LoginFlow>(
		target,
		`/api/identities/connections/${encodeURIComponent(id)}/login`,
		{ method: "POST" }
	);
}

export async function pollConnection(
	target: ApiTarget,
	id: string
): Promise<ConnectionPoll> {
	return await request<ConnectionPoll>(
		target,
		`/api/identities/connections/${encodeURIComponent(id)}`
	);
}

export async function importConnection(
	target: ApiTarget,
	id: string,
	state: string
): Promise<ConnectionPoll> {
	return await request<ConnectionPoll>(
		target,
		`/api/identities/connections/${encodeURIComponent(id)}/import`,
		{ method: "POST", body: { state } }
	);
}

export async function deleteConnection(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		`/api/identities/connections/${encodeURIComponent(id)}`,
		{ method: "DELETE" }
	);
}
