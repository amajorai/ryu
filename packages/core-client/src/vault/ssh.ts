// packages/core-client/src/vault/ssh.ts
//
// SSH: part of the Secret Vault client. `../vault.ts` re-exports these names
// and documents the wire conventions.

import {
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "../client.ts";
import { vaultHumanDeletedEngine, vaultHumanSshCas } from "./codecs-human.ts";
import {
	vaultHumanSshCertRecords,
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

/** A certificate an SSH CA signed, as Core records it. */
export interface VaultSshCertRecord {
	ca: string;
	keyId: string;
	revokedAt?: VaultTimestamp;
	/** Decimal string; serials can exceed JSON's safe integers. */
	serial: string;
	validBefore: VaultTimestamp;
}

/** Revoke one serial (decimal or `0x` hex) or every certificate of a key ID. */
export type VaultSshRevocation = { serial: string } | { keyId: string };

export function listVaultSshCas(
	target: ApiTarget
): Promise<{ cas: Array<{ name: string; publicKey: string }> }> {
	return request(target, "/api/vault/ssh/cas", {}, vaultHumanSshCas);
}

/** CA key types Core generates (lowercase on the wire). */
export const VAULT_SSH_CA_KEY_TYPES = ["ed25519", "rsa", "ecdsa"] as const;

export type VaultSshCaKeyType = (typeof VAULT_SSH_CA_KEY_TYPES)[number];

export interface VaultSshCaOptions {
	/** RSA 2048, 3072 or 4096 (default); ECDSA 256 (default) or 384. */
	keyBits?: number;
	/** `ed25519` when omitted. */
	keyType?: VaultSshCaKeyType;
}

export function createVaultSshCa(
	target: ApiTarget,
	name: string,
	options: VaultSshCaOptions = {}
): Promise<{ publicKey: string }> {
	const body: { keyBits?: number; keyType?: VaultSshCaKeyType; name: string } =
		{ name };
	if (options.keyType !== undefined) {
		body.keyType = options.keyType;
	}
	if (options.keyBits !== undefined) {
		body.keyBits = options.keyBits;
	}
	return request(
		target,
		"/api/vault/ssh/cas",
		{
			method: "POST",
			body,
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

function caPath(ca: string, rest: string): string {
	return `/api/vault/ssh/cas/${encodeURIComponent(ca)}/${rest}`;
}

export function listVaultSshCertificates(
	target: ApiTarget,
	ca: string
): Promise<{ certificates: VaultSshCertRecord[] }> {
	return request(target, caPath(ca, "certs"), {}, vaultHumanSshCertRecords);
}

/** Needs `admin` on `sys/ssh/cas/<ca>`. */
export function revokeVaultSshCertificates(
	target: ApiTarget,
	ca: string,
	what: VaultSshRevocation
): Promise<{ certificates: VaultSshCertRecord[] }> {
	return request(
		target,
		caPath(ca, "revoke"),
		{ method: "POST", body: what },
		vaultHumanSshCertRecords
	);
}

/** The CA's current OpenSSH key revocation list (binary, for `RevokedKeys`). */
export async function getVaultSshKrl(
	target: ApiTarget,
	ca: string
): Promise<Uint8Array> {
	const path = caPath(ca, "krl");
	const response = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, await response.text());
	}
	return new Uint8Array(await response.arrayBuffer());
}
