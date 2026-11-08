// Credential broker console calls: listener status, sessions, the request
// log, discovered hosts, and per-environment settings. A minted session's
// token (and the proxy environment that embeds it) is returned once; callers
// keep it in component state only, never in React Query or storage. Log rows
// carry the method, host and path of brokered requests, never headers,
// bodies or credential values.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";

export interface VaultBrokerStatus {
	caUrl: string;
	listening: boolean;
	port: number | null;
	portEnv: string;
}

export interface VaultBrokerSession {
	createdAt: string;
	environment: string;
	expiresAt: string;
	id: string;
	label: string;
	/** `user:<id>`, `operator`, or `machine:<id>`. */
	mintedBy: string;
	revokedAt?: string;
	services: string[];
}

export interface VaultBrokerSessionInput {
	environment: string;
	label?: string;
	services: string[];
	ttlSecs?: number;
}

export interface VaultBrokerProxy {
	caBundlePath: string;
	caPath: string;
	/** Child-process variables; the proxy URLs embed the session token. */
	env: Record<string, string>;
	port: number;
	url: string;
}

export interface VaultBrokerMintedSession {
	/** `null` when the broker listener is not running on this node. */
	proxy: VaultBrokerProxy | null;
	session: VaultBrokerSession;
	/** The `rvb_` token, shown once. */
	token: string;
}

export type VaultBrokerStatusBucket = "2xx" | "3xx" | "4xx" | "5xx";

export interface VaultBrokerLogFilter {
	before?: number;
	environment?: string;
	limit?: number;
	service?: string;
	sessionId?: string;
	statusBucket?: VaultBrokerStatusBucket;
}

export interface VaultBrokerLogRow {
	at: string;
	environment: string;
	host: string;
	id: number;
	latencyMs: number;
	method: string;
	/** `forwarded`, `tunneled`, `intercepted`, or an error code. */
	outcome: string;
	path: string;
	port: number;
	scheme: string;
	service: string | null;
	sessionId: string | null;
	status: number;
}

export interface VaultBrokerDiscoveredHost {
	environment: string;
	host: string;
	/** Epoch milliseconds. */
	lastSeen: number;
	port: number;
	requests: number;
	/** A catalog template whose host matches. */
	suggestedTemplate?: string;
}

export type VaultBrokerUnmatchedHostPolicy = "deny" | "passthrough";

export interface VaultBrokerEnvironmentSettings {
	/** Broker agent runs in trusted folders under `deny` too (off by default). */
	brokerRunsUnderDeny: boolean;
	environment: string;
	/** Free text served to agents with discovery. */
	skills: string;
	unmatchedHostPolicy: VaultBrokerUnmatchedHostPolicy;
	updatedAt?: string;
}

/** Core caps sessions at one minute to one day. */
export const BROKER_SESSION_TTL = { max: 86_400, min: 60 } as const;

/** Core's page cap for the request log. */
export const BROKER_LOG_PAGE_MAX = 200;

const statusSchema = z.object({
	broker: z
		.object({
			caUrl: z.string(),
			listening: z.boolean(),
			port: z.number().nullable().optional(),
			portEnv: z.string(),
		})
		.passthrough(),
});

const sessionSchema = z
	.object({
		createdAt: z.string(),
		environment: z.string(),
		expiresAt: z.string(),
		id: z.string(),
		label: z.string(),
		mintedBy: z.string(),
		revokedAt: z.string().optional(),
		services: z.array(z.string()),
	})
	.passthrough();

const mintSchema = z.object({
	proxy: z
		.object({
			caBundlePath: z.string(),
			caPath: z.string(),
			env: z.record(z.string(), z.string()),
			port: z.number(),
			url: z.string(),
		})
		.passthrough()
		.nullable(),
	session: sessionSchema,
	token: z.string().startsWith("rvb_"),
});

const listSessionsSchema = z
	.object({ sessions: z.array(sessionSchema).optional() })
	.passthrough();

const logRowSchema = z
	.object({
		at: z.string(),
		environment: z.string(),
		host: z.string(),
		id: z.number(),
		latencyMs: z.number(),
		method: z.string(),
		outcome: z.string(),
		path: z.string(),
		port: z.number(),
		scheme: z.string(),
		service: z.string().nullable(),
		sessionId: z.string().nullable(),
		status: z.number(),
	})
	.passthrough();

const listLogsSchema = z
	.object({ logs: z.array(logRowSchema).optional() })
	.passthrough();

const discoveredSchema = z
	.object({
		hosts: z
			.array(
				z
					.object({
						environment: z.string(),
						host: z.string(),
						lastSeen: z.number(),
						port: z.number(),
						requests: z.number(),
						suggestedTemplate: z.string().optional(),
					})
					.passthrough()
			)
			.optional(),
	})
	.passthrough();

const settingsSchema = z.object({
	settings: z
		.object({
			// Absent from a Core that predates the setting: off.
			brokerRunsUnderDeny: z.boolean().optional().default(false),
			environment: z.string(),
			skills: z.string(),
			unmatchedHostPolicy: z.enum(["deny", "passthrough"]),
			updatedAt: z.string().optional(),
		})
		.passthrough(),
});

const revokedSchema = z.object({ revoked: z.boolean() }).passthrough();

export async function getVaultBrokerStatus(
	target: ApiTarget
): Promise<VaultBrokerStatus> {
	const raw = await request(
		target,
		"/api/vault/broker/status",
		undefined,
		statusSchema
	);
	return { ...raw.broker, port: raw.broker.port ?? null };
}

export async function listVaultBrokerSessions(
	target: ApiTarget
): Promise<VaultBrokerSession[]> {
	const raw = await request(
		target,
		"/api/vault/broker/sessions",
		undefined,
		listSessionsSchema
	);
	return raw?.sessions ?? [];
}

/** Mint a session for `services` (each needs `use`). The token in the reply
 *  is never shown again. */
export async function mintVaultBrokerSession(
	target: ApiTarget,
	input: VaultBrokerSessionInput
): Promise<VaultBrokerMintedSession> {
	const body: Record<string, unknown> = {
		environment: input.environment,
		services: input.services,
	};
	const label = input.label?.trim();
	if (label) {
		body.label = label;
	}
	if (input.ttlSecs !== undefined) {
		body.ttlSecs = input.ttlSecs;
	}
	return await request(
		target,
		"/api/vault/broker/sessions",
		{ body, method: "POST" },
		mintSchema
	);
}

/** `false` when the session had already ended. */
export async function revokeVaultBrokerSession(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const raw = await request(
		target,
		`/api/vault/broker/sessions/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		revokedSchema
	);
	return raw.revoked;
}

/** Newest first. Pass the smallest `id` seen as `before` for older rows. */
export async function listVaultBrokerLogs(
	target: ApiTarget,
	filter: VaultBrokerLogFilter = {}
): Promise<VaultBrokerLogRow[]> {
	const raw = await request(
		target,
		`/api/vault/broker/logs${vaultQueryString({
			before: filter.before,
			environment: filter.environment,
			limit: filter.limit,
			service: filter.service,
			sessionId: filter.sessionId,
			statusBucket: filter.statusBucket,
		})}`,
		undefined,
		listLogsSchema
	);
	return raw?.logs ?? [];
}

export async function listVaultBrokerDiscoveredHosts(
	target: ApiTarget,
	environment?: string
): Promise<VaultBrokerDiscoveredHost[]> {
	const raw = await request(
		target,
		`/api/vault/broker/discovered-hosts${vaultQueryString({ environment })}`,
		undefined,
		discoveredSchema
	);
	return raw?.hosts ?? [];
}

function environmentPath(environment: string): string {
	return `/api/vault/broker/environments/${encodeURIComponent(environment)}`;
}

export async function getVaultBrokerEnvironment(
	target: ApiTarget,
	environment: string
): Promise<VaultBrokerEnvironmentSettings> {
	const raw = await request(
		target,
		environmentPath(environment),
		undefined,
		settingsSchema
	);
	return raw.settings;
}

/** Needs `admin` on `sys/broker`. */
export async function putVaultBrokerEnvironment(
	target: ApiTarget,
	environment: string,
	input: Pick<
		VaultBrokerEnvironmentSettings,
		"brokerRunsUnderDeny" | "skills" | "unmatchedHostPolicy"
	>
): Promise<VaultBrokerEnvironmentSettings> {
	const raw = await request(
		target,
		environmentPath(environment),
		{
			body: {
				brokerRunsUnderDeny: input.brokerRunsUnderDeny,
				skills: input.skills,
				unmatchedHostPolicy: input.unmatchedHostPolicy,
			},
			method: "PUT",
		},
		settingsSchema
	);
	return raw.settings;
}
