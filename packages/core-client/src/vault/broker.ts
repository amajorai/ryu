// packages/core-client/src/vault/broker.ts
//
// Credential broker: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import {
	type ApiTarget,
	apiErrorFromBody,
	fetchForTarget,
	request,
} from "../client.ts";
import type { VaultMachineTarget } from "./agent-routes.ts";
import {
	vaultBrokerCatalogReply,
	vaultBrokerDecisionReply,
	vaultBrokerGrantReply,
	vaultBrokerHostsReply,
	vaultBrokerLogsReply,
	vaultBrokerProposalsReply,
	vaultBrokerServiceReply,
	vaultBrokerServicesReply,
	vaultBrokerSessionsReply,
	vaultBrokerStatusReply,
	vaultDeletedReply,
	vaultMachineRevokedResponse,
} from "./codecs-machine.ts";
import { query } from "./internal.ts";
import type {
	VaultCredentialUse,
	VaultPasswordManagerGrantMode,
} from "./password-manager.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultBrokerStatus {
	caUrl: string;
	listening: boolean;
	port: number | null;
	portEnv: string;
}

/** A brokered upstream. `auth` and `substitutions` keep Core's serde shape. */
export interface VaultBrokerService {
	allowInsecureHttp?: boolean;
	auth: AppJsonValue;
	/** Relayed into cloud-task Boxes (an admin opt-in; off by default). */
	boxRelay?: boolean;
	createdAt: VaultTimestamp;
	description?: string;
	enabled: boolean;
	environment: string;
	host: string;
	name: string;
	notes?: string;
	pathPrefix: string;
	port?: number;
	substitutions?: AppJsonValue[];
	updatedAt: VaultTimestamp;
}

export interface VaultBrokerSession {
	createdAt: VaultTimestamp;
	environment: string;
	expiresAt: VaultTimestamp;
	id: string;
	label: string;
	mintedBy: string;
	revokedAt?: VaultTimestamp;
	services: string[];
}

/** The child-process proxy environment; `null` when the listener is down. */
export interface VaultBrokerProxy {
	caBundlePath: string;
	caPath: string;
	caUrl: string;
	env: Record<string, string>;
	port: number;
	url: string;
}

/** A minted session. `token` is shown once and is also embedded in `proxy.env`. */
export interface VaultBrokerSessionGrant {
	proxy: VaultBrokerProxy | null;
	session: VaultBrokerSession;
	token: string;
}

export interface VaultBrokerSessionInput {
	environment?: string;
	label?: string;
	services: string[];
	ttlSecs?: number;
}

export interface VaultBrokerLogRow {
	at: VaultTimestamp;
	environment: string;
	host: string;
	id: number;
	latencyMs: number;
	method: string;
	outcome: string;
	path: string;
	port: number;
	scheme: string;
	service: string | null;
	sessionId: string | null;
	status: number;
}

export interface VaultBrokerLogFilter {
	before?: number;
	environment?: string;
	limit?: number;
	service?: string;
	sessionId?: string;
	statusBucket?: "2xx" | "3xx" | "4xx" | "5xx";
}

export interface VaultBrokerDiscoveredHost {
	environment: string;
	host: string;
	lastSeen: VaultTimestamp;
	port: number;
	requests: number;
	suggestedTemplate?: string;
}

export type VaultBrokerProposalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired";

export interface VaultBrokerCredentialRequest {
	description: string;
	obtainInstructions: string;
	ref: string;
}

export interface VaultBrokerProposal {
	createdAt: VaultTimestamp;
	credentials: VaultBrokerCredentialRequest[];
	/** Set on a password-manager credential-use request (no services or
	 *  credentials). */
	credentialUse?: VaultCredentialUse;
	decidedAt?: VaultTimestamp;
	decidedBy?: string;
	environment: string;
	expiresAt: VaultTimestamp;
	id: string;
	message: string;
	note?: string;
	requestedBy: string;
	services: AppJsonValue[];
	status: VaultBrokerProposalStatus;
}

export interface VaultBrokerDecisionInput {
	/** Approve only, for a password-manager credential-use request: how long
	 *  the grant lasts (Core defaults to `30d`). */
	grant?: VaultPasswordManagerGrantMode;
	note?: string;
	/** Approve only: values for requested credentials, keyed by `secret:` reference. */
	values?: Record<string, string>;
}

export interface VaultBrokerDiscovery {
	environment: string;
	proposalsEndpoint: string;
	proxy: VaultBrokerStatus;
	services: AppJsonValue[];
	skills: AppJsonValue;
	unmatchedHostPolicy: AppJsonValue;
}

function brokerPath(suffix: string): string {
	return `/api/vault/broker${suffix}`;
}

export function getVaultBrokerStatus(
	target: ApiTarget
): Promise<{ broker: VaultBrokerStatus }> {
	return request(target, brokerPath("/status"), {}, vaultBrokerStatusReply);
}

export function listVaultBrokerCatalog(
	target: ApiTarget
): Promise<{ templates: AppJsonValue[] }> {
	return request(target, brokerPath("/catalog"), {}, vaultBrokerCatalogReply);
}

export function listVaultBrokerServices(
	target: ApiTarget,
	filter: { environment?: string } = {}
): Promise<{ services: VaultBrokerService[] }> {
	return request(
		target,
		brokerPath(`/services${query({ environment: filter.environment })}`),
		{},
		vaultBrokerServicesReply
	);
}

export function getVaultBrokerService(
	target: ApiTarget,
	name: string
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{},
		vaultBrokerServiceReply
	);
}

/** Create a service from a full definition or `{ template, name?, environment?,
 *  credentialRef? }` for a catalog template. */
export function createVaultBrokerService(
	target: ApiTarget,
	input: Record<string, AppJsonValue>
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath("/services"),
		{ method: "POST", body: input },
		vaultBrokerServiceReply
	);
}

export function putVaultBrokerService(
	target: ApiTarget,
	name: string,
	input: Record<string, AppJsonValue>
): Promise<{ service: VaultBrokerService }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{ method: "PUT", body: input },
		vaultBrokerServiceReply
	);
}

export function deleteVaultBrokerService(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		brokerPath(`/services/${encodeURIComponent(name)}`),
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Mint a broker session (`use` on each `sys/broker/<service>`). */
export function createVaultBrokerSession(
	target: ApiTarget,
	input: VaultBrokerSessionInput
): Promise<VaultBrokerSessionGrant> {
	return request(
		target,
		brokerPath("/sessions"),
		{ method: "POST", body: input },
		vaultBrokerGrantReply
	);
}

export function listVaultBrokerSessions(
	target: ApiTarget
): Promise<{ sessions: VaultBrokerSession[] }> {
	return request(target, brokerPath("/sessions"), {}, vaultBrokerSessionsReply);
}

export function revokeVaultBrokerSession(
	target: ApiTarget,
	id: string
): Promise<{ revoked: boolean }> {
	return request(
		target,
		brokerPath(`/sessions/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		vaultMachineRevokedResponse
	);
}

/** The broker CA certificate as PEM text (a public route; 404 before the
 *  first session is minted). */
export async function getVaultBrokerCaPem(
	target: VaultMachineTarget
): Promise<string> {
	const path = brokerPath("/ca.pem");
	const base = target.url.replace(/\/$/, "");
	const response = await fetchForTarget(target)(`${base}${path}`, {
		method: "GET",
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return text;
}

export function listVaultBrokerLogs(
	target: ApiTarget,
	filter: VaultBrokerLogFilter = {}
): Promise<{ logs: VaultBrokerLogRow[] }> {
	return request(
		target,
		brokerPath(
			`/logs${query({
				environment: filter.environment,
				service: filter.service,
				sessionId: filter.sessionId,
				statusBucket: filter.statusBucket,
				before: filter.before,
				limit: filter.limit,
			})}`
		),
		{},
		vaultBrokerLogsReply
	);
}

export function listVaultBrokerDiscoveredHosts(
	target: ApiTarget,
	filter: { environment?: string } = {}
): Promise<{ hosts: VaultBrokerDiscoveredHost[] }> {
	return request(
		target,
		brokerPath(
			`/discovered-hosts${query({ environment: filter.environment })}`
		),
		{},
		vaultBrokerHostsReply
	);
}

export function listVaultBrokerProposals(
	target: ApiTarget,
	filter: { status?: VaultBrokerProposalStatus } = {}
): Promise<{ proposals: VaultBrokerProposal[] }> {
	return request(
		target,
		brokerPath(`/proposals${query({ status: filter.status })}`),
		{},
		vaultBrokerProposalsReply
	);
}

/** Approve (optionally supplying requested credential values) or reject an
 *  agent proposal. Needs `admin` on `sys/broker`. */
export function decideVaultBrokerProposal(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	input: VaultBrokerDecisionInput = {}
): Promise<{ approved: true; proposal: string } | { rejected: true }> {
	const body: VaultBrokerDecisionInput = {};
	if (input.note) {
		body.note = input.note;
	}
	if (decision === "approve" && input.values) {
		body.values = input.values;
	}
	if (decision === "approve" && input.grant) {
		body.grant = input.grant;
	}
	return request(
		target,
		brokerPath(`/proposals/${encodeURIComponent(id)}/${decision}`),
		{ method: "POST", body },
		vaultBrokerDecisionReply
	);
}
