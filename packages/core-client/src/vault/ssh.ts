// packages/core-client/src/vault/ssh.ts
//
// SSH: part of the Secret Vault client. `../vault.ts` re-exports these names
// and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import { vaultHumanDeletedEngine, vaultHumanSshCas } from "./codecs-human.ts";
import {
	vaultHumanSshPublicKey,
	vaultHumanSshRoleResponse,
	vaultHumanSshRoles,
} from "./codecs-human-engines.ts";
import { vaultMachineSshResponse } from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultSshRole {
	allowedPrincipals: string[];
	ca: string;
	certType: "user" | "host";
	defaultTtlSecs: number;
	extensions?: string[];
	maxTtlSecs: number;
	name: string;
}

export interface VaultSshSignInput {
	keyId?: string;
	principals?: string[];
	publicKey: string;
	ttlSecs?: number;
}

export interface VaultSshCertificate {
	certificate: string;
	keyId: string;
	principals: string[];
	serial: number;
	/** RFC 3339 after rendering, or a raw epoch-second fallback. */
	validAfter: VaultTimestamp;
	/** RFC 3339 after rendering, or a raw epoch-second fallback. */
	validBefore: VaultTimestamp;
}

export function listVaultSshCas(
	target: ApiTarget
): Promise<{ cas: Array<{ name: string; publicKey: string }> }> {
	return request(target, "/api/vault/ssh/cas", {}, vaultHumanSshCas);
}

export function createVaultSshCa(
	target: ApiTarget,
	name: string
): Promise<{ publicKey: string }> {
	return request(
		target,
		"/api/vault/ssh/cas",
		{
			method: "POST",
			body: { name },
		},
		vaultHumanSshPublicKey
	);
}

export function listVaultSshRoles(
	target: ApiTarget
): Promise<{ roles: VaultSshRole[] }> {
	return request(target, "/api/vault/ssh/roles", {}, vaultHumanSshRoles);
}

export function putVaultSshRole(
	target: ApiTarget,
	name: string,
	role: Omit<VaultSshRole, "name">
): Promise<{ role: VaultSshRole }> {
	return request(
		target,
		`/api/vault/ssh/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: role,
		},
		vaultHumanSshRoleResponse
	);
}

export function deleteVaultSshRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/ssh/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function signVaultSshKey(
	target: ApiTarget,
	role: string,
	input: VaultSshSignInput
): Promise<{ certificate: VaultSshCertificate }> {
	return request(
		target,
		`/api/vault/ssh/sign/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		},
		vaultMachineSshResponse
	);
}
