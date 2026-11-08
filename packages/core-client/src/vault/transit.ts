// packages/core-client/src/vault/transit.ts
//
// Transit: part of the Secret Vault client. `../vault.ts` re-exports these
// names and documents the wire conventions.

import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanDeletedEngine,
	vaultHumanTransitKeyResponse,
	vaultHumanTransitKeys,
	vaultHumanTransitResponses,
} from "./codecs-human.ts";
import type { VAULT_TRANSIT_KEY_TYPES } from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export type KnownVaultTransitKeyType = (typeof VAULT_TRANSIT_KEY_TYPES)[number];

/** Known key types, plus any type a newer server reports. */
export type VaultTransitKeyType =
	| KnownVaultTransitKeyType
	| (string & Record<never, never>);

export interface VaultTransitKey {
	allowPlaintextBackup?: boolean;
	/** `0` disables automatic rotation. */
	autoRotatePeriodSecs?: number;
	convergent?: boolean;
	createdAt: VaultTimestamp;
	/** Set while the key is soft-deleted. */
	deletedAt?: VaultTimestamp;
	deletionAllowed: boolean;
	derived?: boolean;
	exportable?: boolean;
	imported?: boolean;
	latestVersion: number;
	/** Versions below this were trimmed. */
	minAvailableVersion?: number;
	minDecryptionVersion: number;
	/** `0` means any available version may encrypt, sign, or HMAC. */
	minEncryptionVersion?: number;
	name: string;
	/** `[version, public key]` pairs: base64 for Ed25519, SPKI PEM for ECDSA
	 *  and RSA, empty for symmetric and HMAC keys. */
	publicKeys: [number, string][];
	type: VaultTransitKeyType;
}

/** Options shared by encrypt, decrypt, rewrap, sign, verify, and hmac. */
export interface VaultTransitOpOptions {
	/** Base64 associated data authenticated with the ciphertext. */
	associatedData?: string;
	/** Derived keys: the base64 derivation context. */
	context?: string;
	/** Version to encrypt, sign, or HMAC with (default: latest). */
	keyVersion?: number;
	/** RSA signatures: `pss` (default) or `pkcs1v15`. */
	signatureAlgorithm?: string;
}

/** Request and response bodies per transit operation. Plaintext, context, and
 *  input are base64. */
export interface VaultTransitOperations {
	datakey: {
		body: Record<string, never>;
		result: { ciphertext: string; plaintext: string };
	};
	decrypt: {
		body: VaultTransitOpOptions & { ciphertext: string };
		result: { plaintext: string };
	};
	encrypt: {
		body: VaultTransitOpOptions & { plaintext: string };
		result: { ciphertext: string };
	};
	hmac: {
		body: VaultTransitOpOptions & { input: string };
		result: { hmac: string };
	};
	rewrap: {
		body: VaultTransitOpOptions & { ciphertext: string };
		result: { ciphertext: string };
	};
	rotate: { body: Record<string, never>; result: { key: VaultTransitKey } };
	sign: {
		body: VaultTransitOpOptions & { input: string };
		result: { signature: string };
	};
	/** Pass `signature` for a signature or `hmac` for an HMAC. */
	verify: {
		body: VaultTransitOpOptions & {
			hmac?: string;
			input: string;
			signature?: string;
		};
		result: { valid: boolean };
	};
}

export type VaultTransitOperation = keyof VaultTransitOperations;

export function listVaultTransitKeys(
	target: ApiTarget
): Promise<{ keys: VaultTransitKey[] }> {
	return request(target, "/api/vault/transit/keys", {}, vaultHumanTransitKeys);
}

export function createVaultTransitKey(
	target: ApiTarget,
	input: { name: string; type?: VaultTransitKeyType }
): Promise<{ key: VaultTransitKey }> {
	return request(
		target,
		"/api/vault/transit/keys",
		{
			method: "POST",
			body: input,
		},
		vaultHumanTransitKeyResponse
	);
}

export function configureVaultTransitKey(
	target: ApiTarget,
	name: string,
	input: {
		allowPlaintextBackup?: boolean;
		autoRotatePeriodSecs?: number;
		deletionAllowed?: boolean;
		exportable?: boolean;
		minDecryptionVersion?: number;
		minEncryptionVersion?: number;
	}
): Promise<{ key: VaultTransitKey }> {
	return request(
		target,
		`/api/vault/transit/keys/${encodeURIComponent(name)}`,
		{
			method: "PATCH",
			body: input,
		},
		vaultHumanTransitKeyResponse
	);
}

export function deleteVaultTransitKey(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/transit/keys/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function vaultTransit<Op extends VaultTransitOperation>(
	target: ApiTarget,
	op: Op,
	name: string,
	body: VaultTransitOperations[Op]["body"]
): Promise<VaultTransitOperations[Op]["result"]> {
	return request(
		target,
		`/api/vault/transit/${op}/${encodeURIComponent(name)}`,
		{
			method: "POST",
			body,
		},
		vaultHumanTransitResponses[op]
	);
}
