// packages/core-client/src/vault/tokens.ts
//
// Token lifecycle, response wrapping, cubbyhole: part of the Secret Vault
// client. `../vault.ts` re-exports these names and documents the wire
// conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import type {
	VaultAgentTarget,
	VaultIssuedToken,
	VaultMachineTarget,
} from "./agent-routes.ts";
import {
	vaultDeletedReply,
	vaultMachineLoginResponse,
} from "./codecs-machine.ts";
import {
	VAULT_WRAP_TTL_HEADER,
	vaultCubbyholeKeysReply,
	vaultCubbyholeValueReply,
	vaultRevokeReportReply,
	vaultTokenInfoReply,
	vaultTokenRoleReply,
	vaultTokenRolesReply,
	vaultTokenSelfReply,
	vaultTokensReply,
	vaultUnwrappedReply,
	vaultWrapInfoReply,
	vaultWrittenReply,
} from "./codecs-reply.ts";
import { agentRequest, machineRequest, query, secretPath } from "./internal.ts";
import type { VaultCoords, VaultTimestamp } from "./shared.ts";

export interface VaultTokenInfo {
	accessor: string;
	boundCidrs: string[];
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	identityId: string;
	lastUsedAt: VaultTimestamp | null;
	maxExpiresAt: VaultTimestamp | null;
	numUsesRemaining: number | null;
	orphan: boolean;
	parentAccessor: string | null;
	periodSecs: number | null;
	policies: string[];
	renewable: boolean;
	revokedAt: VaultTimestamp | null;
	role: string | null;
	ttlSecs: number;
}

export interface VaultTokenRequest {
	boundCidrs?: string[];
	explicitMaxTtlSecs?: number;
	numUses?: number;
	orphan?: boolean;
	periodSecs?: number;
	policies?: string[];
	renewable?: boolean;
	role?: string;
	ttlSecs?: number;
}

export interface VaultTokenRole {
	allowedPolicies: string[];
	boundCidrs?: string[];
	createdAt: VaultTimestamp;
	disallowedPolicies: string[];
	explicitMaxTtlSecs?: number;
	maxTtlSecs?: number;
	name: string;
	numUses?: number;
	orphan: boolean;
	periodSecs?: number;
	renewable?: boolean;
	ttlSecs?: number;
	updatedAt: VaultTimestamp;
}

export type VaultTokenRoleInput = Partial<
	Omit<VaultTokenRole, "name" | "createdAt" | "updatedAt">
>;

export interface VaultRevokeReport {
	leasesFailed: number;
	leasesRevoked: number;
	tokens: number;
}

export interface VaultWrapInfo {
	accessor: string;
	createdAt: VaultTimestamp;
	creationPath: string;
	expiresAt: VaultTimestamp;
	/** The single-use wrapping token; absent from lookups. */
	token?: string;
	ttlSecs: number;
}

export interface VaultCubbyholeEntry {
	createdAt: VaultTimestamp;
	key: string;
	updatedAt: VaultTimestamp;
}

function tokenPath(accessor: string, suffix = ""): string {
	return `/api/vault/tokens/${encodeURIComponent(accessor)}${suffix}`;
}

function wrapTtlHeaders(ttl: string | number | undefined): {
	[name: string]: string;
} {
	return ttl === undefined ? {} : { [VAULT_WRAP_TTL_HEADER]: String(ttl) };
}

export function listVaultTokens(
	target: ApiTarget,
	filter: { identity?: string } = {}
): Promise<{ tokens: VaultTokenInfo[] }> {
	return request(
		target,
		`/api/vault/tokens${query({ identity: filter.identity })}`,
		{},
		vaultTokensReply
	);
}

/** Mint a token for a machine identity; the `rvt_…` token is shown once. */
export function createVaultToken(
	target: ApiTarget,
	input: VaultTokenRequest & { identity: string }
): Promise<{ token: VaultIssuedToken }> {
	return request(
		target,
		"/api/vault/tokens",
		{ method: "POST", body: input },
		vaultMachineLoginResponse
	);
}

export function lookupVaultToken(
	target: ApiTarget,
	accessor: string
): Promise<{ token: VaultTokenInfo }> {
	return request(target, tokenPath(accessor), {}, vaultTokenInfoReply);
}

export function renewVaultToken(
	target: ApiTarget,
	accessor: string,
	options: { incrementSecs?: number } = {}
): Promise<{ token: VaultTokenInfo }> {
	return request(
		target,
		tokenPath(accessor, "/renew"),
		{ method: "POST", body: options },
		vaultTokenInfoReply
	);
}

/** Revoke a token but keep its children as orphans (admin on `sys/machines`). */
export function revokeVaultTokenOrphan(
	target: ApiTarget,
	accessor: string
): Promise<{ revoked: VaultRevokeReport }> {
	return request(
		target,
		tokenPath(accessor, "/revoke-orphan"),
		{ method: "POST" },
		vaultRevokeReportReply
	);
}

export function listVaultTokenRoles(
	target: ApiTarget
): Promise<{ roles: VaultTokenRole[] }> {
	return request(target, "/api/vault/token-roles", {}, vaultTokenRolesReply);
}

export function getVaultTokenRole(
	target: ApiTarget,
	name: string
): Promise<{ role: VaultTokenRole }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{},
		vaultTokenRoleReply
	);
}

export function putVaultTokenRole(
	target: ApiTarget,
	name: string,
	input: VaultTokenRoleInput
): Promise<{ role: VaultTokenRole }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{ method: "PUT", body: input },
		vaultTokenRoleReply
	);
}

export function deleteVaultTokenRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/token-roles/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
		vaultDeletedReply
	);
}

/** Wrap a JSON object behind a single-use wrapping token (`use` on
 *  `sys/wrapping`). `ttl` defaults to Core's wrap TTL. */
export function vaultWrap(
	target: ApiTarget,
	data: Record<string, AppJsonValue>,
	options: { ttl?: string | number } = {}
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return request(
		target,
		"/api/vault/sys/wrapping/wrap",
		{ method: "POST", body: data, headers: wrapTtlHeaders(options.ttl) },
		vaultWrapInfoReply
	);
}

/** Unwrap once and return the original response. Public: no bearer is sent. */
export function vaultUnwrap(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<Record<string, AppJsonValue>> {
	return machineRequest(
		vaultUnwrappedReply,
		target,
		"/api/vault/sys/wrapping/unwrap",
		{ method: "POST", body: { token: wrapToken } }
	);
}

/** Describe a wrapping token without consuming it. */
export function vaultWrapLookup(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return machineRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/sys/wrapping/lookup",
		{ method: "POST", body: { token: wrapToken } }
	);
}

/** Move a wrapped response to a new token (consumes the old one). */
export function vaultRewrap(
	target: VaultMachineTarget,
	wrapToken: string
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return machineRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/sys/wrapping/rewrap",
		{ method: "POST", body: { token: wrapToken } }
	);
}

export function vaultAgentLookupSelf(
	target: VaultAgentTarget
): Promise<{ effectivePolicies: string[]; token: VaultTokenInfo }> {
	return agentRequest(
		vaultTokenSelfReply,
		target,
		"/api/vault/agent/self/lookup"
	);
}

export function vaultAgentRenewSelf(
	target: VaultAgentTarget,
	options: { incrementSecs?: number } = {}
): Promise<{ token: VaultTokenInfo }> {
	return agentRequest(
		vaultTokenInfoReply,
		target,
		"/api/vault/agent/self/renew",
		{ method: "POST", body: options }
	);
}

/** Mint a narrower child token (policy subset; TTL capped by the parent). */
export function vaultAgentCreateChild(
	target: VaultAgentTarget,
	input: VaultTokenRequest = {}
): Promise<{ token: VaultIssuedToken }> {
	return agentRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/agent/self/child",
		{ method: "POST", body: input }
	);
}

export function vaultAgentWrap(
	target: VaultAgentTarget,
	data: Record<string, AppJsonValue>,
	options: { ttl?: string | number } = {}
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return agentRequest(
		vaultWrapInfoReply,
		target,
		"/api/vault/agent/wrapping/wrap",
		{ method: "POST", body: data, headers: wrapTtlHeaders(options.ttl) }
	);
}

/** Reveal a value wrapped behind a single-use token: Core wraps the reveal
 *  response itself, so the plaintext never reaches this client. */
export function wrapVaultSecret(
	target: ApiTarget,
	name: string,
	coords: VaultCoords & { version?: number },
	ttl: string | number
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return request(
		target,
		secretPath(name, "/reveal"),
		{ method: "POST", body: coords, headers: wrapTtlHeaders(ttl) },
		vaultWrapInfoReply
	);
}

/** {@link wrapVaultSecret} with a machine token (node-scoped values). */
export function vaultAgentWrapSecret(
	target: VaultAgentTarget,
	name: string,
	location: { environment?: string; path?: string },
	ttl: string | number
): Promise<{ wrapInfo: VaultWrapInfo }> {
	return agentRequest(
		vaultWrapInfoReply,
		target,
		`/api/vault/agent/secrets/${encodeURIComponent(name)}${query(location)}`,
		{ headers: wrapTtlHeaders(ttl) }
	);
}

function cubbyholePath(key?: string): string {
	return `/api/vault/agent/cubbyhole${key === undefined ? "" : `/${encodeURIComponent(key)}`}`;
}

export function vaultAgentCubbyholeList(
	target: VaultAgentTarget
): Promise<{ keys: VaultCubbyholeEntry[] }> {
	return agentRequest(vaultCubbyholeKeysReply, target, cubbyholePath());
}

export function vaultAgentCubbyholeGet(
	target: VaultAgentTarget,
	key: string
): Promise<{ value: AppJsonValue }> {
	return agentRequest(vaultCubbyholeValueReply, target, cubbyholePath(key));
}

export function vaultAgentCubbyholePut(
	target: VaultAgentTarget,
	key: string,
	value: AppJsonValue
): Promise<{ written: boolean }> {
	return agentRequest(vaultWrittenReply, target, cubbyholePath(key), {
		method: "PUT",
		body: value,
	});
}

export function vaultAgentCubbyholeDelete(
	target: VaultAgentTarget,
	key: string
): Promise<{ deleted: boolean }> {
	return agentRequest(vaultDeletedReply, target, cubbyholePath(key), {
		method: "DELETE",
	});
}
