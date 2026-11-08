// packages/core-client/src/vault/agent-routes.ts
//
// Machine login and agent routes (public, token-authenticated): part of the
// Secret Vault client. `../vault.ts` re-exports these names and documents the
// wire conventions.

import type { z } from "zod";
import type { RyuFetch } from "../client.ts";
import {
	vaultMachineDynamicResponse,
	vaultMachineExportResponse,
	vaultMachineLeaseResponse,
	vaultMachineLoginResponse,
	vaultMachinePkiResponse,
	vaultMachineRevokedResponse,
	vaultMachineSelfResponse,
	vaultMachineSshResponse,
	vaultMachineTransitResponses,
	vaultMachineValueResponse,
} from "./codecs-machine.ts";
import { agentRequest, machineRequest, query } from "./internal.ts";
import type { VaultPkiIssueInput } from "./pki.ts";
import type { VaultSshSignInput } from "./ssh.ts";
import type { VaultExportInput, VaultExportResult } from "./transfer.ts";
import type {
	VaultTransitOperation,
	VaultTransitOperations,
} from "./transit.ts";

/** A node URL for the public machine routes. No node bearer is ever sent. */
export interface VaultMachineTarget {
	fetch?: RyuFetch;
	url: string;
}

/** A machine target holding a vault token for `/api/vault/agent/*`. */
export interface VaultAgentTarget extends VaultMachineTarget {
	vaultToken: string;
}

export interface VaultIssuedToken {
	accessor: string;
	expiresAt: string | number;
	identityId: string;
	policies: string[];
	/** The `rvt_…` token, shown once. */
	token: string;
}

export interface VaultTokenPrincipal {
	accessor: string;
	expiresAt: string | number;
	identityId: string;
	identityName: string;
	policies: string[];
}

/** Exchange an AppRole role id and secret id for a short-lived vault token. */
export function vaultAppRoleLogin(
	target: VaultMachineTarget,
	input: { roleId: string; secretId: string }
): Promise<{ token: VaultIssuedToken }> {
	return machineRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/auth/approle/login",
		{
			method: "POST",
			body: input,
		}
	);
}

/** Exchange an OIDC JWT (for example a GitHub Actions ID token) for a vault token. */
export function vaultJwtLogin(
	target: VaultMachineTarget,
	input: { identity: string; jwt: string }
): Promise<{ token: VaultIssuedToken }> {
	return machineRequest(
		vaultMachineLoginResponse,
		target,
		"/api/vault/auth/jwt/login",
		{
			method: "POST",
			body: input,
		}
	);
}

export function vaultAgentSelf(
	target: VaultAgentTarget
): Promise<{ token: VaultTokenPrincipal }> {
	return agentRequest(
		vaultMachineSelfResponse,
		target,
		"/api/vault/agent/self"
	);
}

export function vaultAgentRevokeSelf(
	target: VaultAgentTarget
): Promise<{ revoked: boolean }> {
	return agentRequest(
		vaultMachineRevokedResponse,
		target,
		"/api/vault/agent/self/revoke",
		{
			method: "POST",
		}
	);
}

/** Export node-scoped values the token may read. Kubernetes naming options are
 *  not accepted on this route. */
export function vaultAgentExport(
	target: VaultAgentTarget,
	input: Omit<VaultExportInput, "k8sName" | "k8sNamespace"> = {}
): Promise<VaultExportResult> {
	return agentRequest(
		vaultMachineExportResponse,
		target,
		"/api/vault/agent/export",
		{
			method: "POST",
			body: input,
		}
	);
}

/** Read one node-scoped value with a machine token. */
export function vaultAgentSecret(
	target: VaultAgentTarget,
	name: string,
	location: { environment?: string; path?: string } = {}
): Promise<{ value: string }> {
	return agentRequest(
		vaultMachineValueResponse,
		target,
		`/api/vault/agent/secrets/${encodeURIComponent(name)}${query(location)}`
	);
}

export function vaultAgentDynamicIssue(
	target: VaultAgentTarget,
	role: string,
	ttlSecs?: number
): Promise<z.output<typeof vaultMachineDynamicResponse>> {
	return agentRequest(
		vaultMachineDynamicResponse,
		target,
		`/api/vault/agent/dynamic/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		}
	);
}

export function vaultAgentLease(
	target: VaultAgentTarget,
	id: string,
	op: "renew" | "revoke",
	ttlSecs?: number
): Promise<z.output<typeof vaultMachineLeaseResponse>> {
	return agentRequest(
		vaultMachineLeaseResponse,
		target,
		`/api/vault/agent/leases/${encodeURIComponent(id)}/${op}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		}
	);
}

export function vaultAgentTransit<
	Op extends Exclude<VaultTransitOperation, "rotate">,
>(
	target: VaultAgentTarget,
	op: Op,
	name: string,
	body: VaultTransitOperations[Op]["body"]
): Promise<VaultTransitOperations[Op]["result"]> {
	return agentRequest(
		vaultMachineTransitResponses[op],
		target,
		`/api/vault/agent/transit/${op}/${encodeURIComponent(name)}`,
		{ method: "POST", body }
	);
}

export function vaultAgentPki(
	target: VaultAgentTarget,
	op: "issue" | "sign",
	role: string,
	input: VaultPkiIssueInput
): Promise<z.output<typeof vaultMachinePkiResponse>> {
	return agentRequest(
		vaultMachinePkiResponse,
		target,
		`/api/vault/agent/pki/${op}/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		}
	);
}

export function vaultAgentSshSign(
	target: VaultAgentTarget,
	role: string,
	input: VaultSshSignInput
): Promise<z.output<typeof vaultMachineSshResponse>> {
	return agentRequest(
		vaultMachineSshResponse,
		target,
		`/api/vault/agent/ssh/sign/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		}
	);
}
