// packages/core-client/src/vault/pki.ts
//
// PKI: part of the Secret Vault client. `../vault.ts` re-exports these names
// and documents the wire conventions.

import {
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "../client.ts";
import {
	vaultHumanDeletedEngine,
	vaultHumanPkiIssuerResponse,
	vaultHumanPkiIssuers,
	vaultHumanPkiRecordResponse,
	vaultHumanPkiRecords,
	vaultHumanPkiRoleResponse,
	vaultHumanPkiRoles,
} from "./codecs-human.ts";
import { vaultMachinePkiResponse } from "./codecs-machine.ts";
import type { VaultTimestamp } from "./shared.ts";

export interface VaultPkiIssuer {
	certificate: string;
	commonName: string;
	name: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
}

export interface VaultPkiRole {
	allowedDomains: string[];
	allowIpSans?: boolean;
	clientFlag?: boolean;
	defaultTtlSecs: number;
	issuer: string;
	maxTtlSecs: number;
	name: string;
	serverFlag?: boolean;
}

export interface VaultPkiIssueInput {
	altNames?: string[];
	commonName: string;
	/** PEM certificate signing request (required for `sign`). */
	csr?: string;
	ipSans?: string[];
	ttlSecs?: number;
}

export interface VaultIssuedCertificate {
	certificate: string;
	issuingCa: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
	/** Returned once for `issue`; never stored. */
	privateKey?: string;
	serial: string;
}

export interface VaultCertRecord {
	commonName: string;
	issuer: string;
	/** RFC 3339 after rendering, or a raw epoch-millisecond fallback. */
	notAfter: VaultTimestamp;
	revokedAt: VaultTimestamp | null;
	serial: string;
}

export function listVaultPkiIssuers(
	target: ApiTarget
): Promise<{ issuers: VaultPkiIssuer[] }> {
	return request(target, "/api/vault/pki/issuers", {}, vaultHumanPkiIssuers);
}

export function createVaultPkiIssuer(
	target: ApiTarget,
	input: { commonName: string; name: string; ttlSecs?: number }
): Promise<{ issuer: VaultPkiIssuer }> {
	return request(
		target,
		"/api/vault/pki/issuers",
		{
			method: "POST",
			body: input,
		},
		vaultHumanPkiIssuerResponse
	);
}

export function listVaultPkiCertificates(
	target: ApiTarget,
	issuer: string
): Promise<{ certificates: VaultCertRecord[] }> {
	return request(
		target,
		`/api/vault/pki/issuers/${encodeURIComponent(issuer)}/certs`,
		{},
		vaultHumanPkiRecords
	);
}

/** The issuer's current CRL as PEM text (not JSON). */
export async function getVaultPkiCrl(
	target: ApiTarget,
	issuer: string
): Promise<string> {
	const path = `/api/vault/pki/issuers/${encodeURIComponent(issuer)}/crl`;
	const response = await fetchForTarget(target)(apiUrl(target, path), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return text;
}

export function listVaultPkiRoles(
	target: ApiTarget
): Promise<{ roles: VaultPkiRole[] }> {
	return request(target, "/api/vault/pki/roles", {}, vaultHumanPkiRoles);
}

export function putVaultPkiRole(
	target: ApiTarget,
	name: string,
	role: Omit<VaultPkiRole, "name">
): Promise<{ role: VaultPkiRole }> {
	return request(
		target,
		`/api/vault/pki/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: role,
		},
		vaultHumanPkiRoleResponse
	);
}

export function deleteVaultPkiRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/pki/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

/** `issue` mints a key pair; `sign` signs `input.csr`. */
export function vaultPki(
	target: ApiTarget,
	op: "issue" | "sign",
	role: string,
	input: VaultPkiIssueInput
): Promise<{ certificate: VaultIssuedCertificate }> {
	return request(
		target,
		`/api/vault/pki/${op}/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: input,
		},
		vaultMachinePkiResponse
	);
}

export function revokeVaultPkiCertificate(
	target: ApiTarget,
	serial: string
): Promise<{ certificate: VaultCertRecord }> {
	return request(
		target,
		"/api/vault/pki/revoke",
		{
			method: "POST",
			body: { serial },
		},
		vaultHumanPkiRecordResponse
	);
}
