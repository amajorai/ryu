// packages/core-client/src/vault/transfer.ts
//
// Export, import, snapshot, scan: part of the Secret Vault client.
// `../vault.ts` re-exports these names and documents the wire conventions.

import { z } from "zod";
import { type ApiTarget, request } from "../client.ts";
import {
	vaultHumanFindings,
	vaultHumanImported,
	vaultHumanSnapshot,
} from "./codecs-human.ts";
import {
	vaultExportObject,
	vaultMachineExportResponse,
} from "./codecs-machine.ts";
import type { VaultExportValues } from "./internal.ts";
import type { VaultCoords } from "./shared.ts";

export type VaultExportFormat =
	| "dotenv"
	| "json"
	| "yaml"
	| "shell"
	| "k8s-secret";

export interface VaultExportInput {
	environment?: string;
	format?: VaultExportFormat;
	k8sName?: string;
	k8sNamespace?: string;
	/** Restrict the export to these names. */
	names?: string[];
	path?: string;
	/**
	 * Include this organization project's values (ahead of Team and
	 * Organization values). The control plane checks you can reach it.
	 */
	projectId?: string;
}

export interface VaultExportResult {
	content: string;
	contentType: string;
	count: number;
	environment: string;
	format: VaultExportFormat;
	path: string;
	/**
	 * Set when the control plane could not be reached: the export holds only
	 * your own and this node's values, without Team and Organization values.
	 */
	sharedError?: string | null;
}

/** Render the effective values for an environment/folder (requires `read`). */
export function exportVaultSecrets(
	target: ApiTarget,
	input: VaultExportInput = {}
): Promise<VaultExportResult> {
	return request(
		target,
		"/api/vault/export",
		{ method: "POST", body: input },
		vaultMachineExportResponse
	);
}

/** Parse a `format: "json"` export into a name→value map. */
export function parseVaultJsonExport(
	result: VaultExportResult
): VaultExportValues {
	const parsed = vaultExportObject.safeParse(JSON.parse(result.content));
	if (!parsed.success) {
		throw new Error("Vault export is not a JSON object");
	}
	const values: VaultExportValues = {};
	for (const [key, value] of Object.entries(parsed.data)) {
		const text = z.string().safeParse(value);
		if (text.success) {
			values[key] = text.data;
		}
	}
	return values;
}

export type VaultImportFormat = "dotenv" | "json" | "snapshot";

export type VaultOnConflict = "skip" | "overwrite";

export interface VaultImportInput extends VaultCoords {
	content: string;
	format: VaultImportFormat;
	onConflict?: VaultOnConflict;
	/** Required for `snapshot`. */
	passphrase?: string;
}

export interface VaultImportReport {
	created: number;
	skipped: number;
	unchanged: number;
	updated: number;
}

export function importVaultSecrets(
	target: ApiTarget,
	input: VaultImportInput
): Promise<{ ok: boolean; report: VaultImportReport }> {
	return request(
		target,
		"/api/vault/import",
		{ method: "POST", body: input },
		vaultHumanImported
	);
}

export interface VaultSnapshotEnvelope {
	ciphertext: string;
	createdAt: string;
	format: string;
	kdf: { alg: string; iterations: number; salt: string };
	nonce: string;
	version: number;
}

/** Export a passphrase-sealed, portable snapshot of readable values. */
export function exportVaultSnapshot(
	target: ApiTarget,
	input: { environment?: string; passphrase: string; path?: string }
): Promise<VaultSnapshotEnvelope> {
	return request(
		target,
		"/api/vault/snapshot",
		{
			method: "POST",
			body: input,
		},
		vaultHumanSnapshot
	);
}

export interface VaultScanFile {
	content: string;
	path?: string;
}

export interface VaultScanInput {
	/** Finding fingerprints to suppress. */
	allow?: string[];
	files: VaultScanFile[];
	/** Also match stored values the caller may read (Core default: true). */
	knownValues?: boolean;
}

export interface VaultFinding {
	column: number;
	description: string;
	fingerprint: string;
	line: number;
	/** Redacted preview of the match. */
	preview: string;
	rule: string;
	/** For `vault-value` findings, the `ENV/folder/NAME` that leaked. */
	secret?: string;
	source?: string;
}

export function scanForVaultSecrets(
	target: ApiTarget,
	input: VaultScanInput
): Promise<{ findings: VaultFinding[] }> {
	return request(
		target,
		"/api/vault/scan",
		{ method: "POST", body: input },
		vaultHumanFindings
	);
}
