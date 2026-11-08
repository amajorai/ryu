// packages/core-client/src/vault/codecs-human.ts
//
// Response codecs for the human value, environment, policy, and audit routes of
// the Secret Vault client. `../vault.ts` re-exports the public names and
// documents the wire conventions.

import { z } from "zod";
import { appJsonValueSchema } from "../app-request-json.ts";
import {
	vaultMachineCodec,
	vaultMachineTransitResponses,
} from "./codecs-machine.ts";
import {
	vaultHumanApproval,
	vaultHumanBinding,
	vaultHumanCapabilities,
	vaultHumanCoords,
	vaultHumanNumber,
	vaultHumanScope,
	vaultHumanSeal,
	vaultHumanSecret,
	vaultHumanText,
	vaultHumanTimestamp,
} from "./codecs-reply.ts";
import type { VaultHumanTransitCodecs } from "./internal.ts";

const vaultHumanChange = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		status: z.enum(["pending", "applied", "rejected", "canceled"]),
		operation: z.enum(["write", "delete"]),
		coords: vaultHumanCoords,
		hasValue: z.boolean(),
		patch: appJsonValueSchema,
		requestedBy: vaultHumanText,
		requestedAt: vaultHumanTimestamp.nullable(),
		approvals: z.array(vaultHumanApproval),
		requiredApprovals: vaultHumanNumber,
		decidedBy: vaultHumanText.nullable(),
		decidedAt: vaultHumanTimestamp.nullable(),
		reason: vaultHumanText.nullable(),
	})
);

export const vaultHumanWrite = vaultMachineCodec(
	z.union([
		z.object({ ok: z.boolean(), secret: vaultHumanSecret }),
		z.object({ ok: z.boolean(), changeRequest: vaultHumanChange }),
	])
);

export const vaultHumanDelete = vaultMachineCodec(
	z.union([
		z.object({
			ok: z.boolean(),
			deleted: z.boolean(),
			scope: vaultHumanScope,
			scopeId: vaultHumanText,
			name: vaultHumanText,
			environment: vaultHumanText,
			path: vaultHumanText,
			binding: vaultHumanBinding.nullable().optional(),
		}),
		z.object({ ok: z.boolean(), changeRequest: vaultHumanChange }),
	])
);

const vaultHumanVersion = vaultMachineCodec(
	z.object({
		version: vaultHumanNumber,
		createdAt: vaultHumanTimestamp.nullable(),
		createdBy: vaultHumanText.nullable(),
		source: vaultHumanText,
		destroyed: z.boolean(),
		current: z.boolean(),
	})
);

export const vaultHumanVersions = vaultMachineCodec(
	z.object({ versions: z.array(vaultHumanVersion) })
);

export const vaultHumanDestroyed = vaultMachineCodec(
	z.object({ ok: z.boolean(), destroyed: vaultHumanNumber })
);

const vaultHumanImportReport = vaultMachineCodec(
	z.object({
		created: vaultHumanNumber,
		updated: vaultHumanNumber,
		skipped: vaultHumanNumber,
		unchanged: vaultHumanNumber,
	})
);

export const vaultHumanImported = vaultMachineCodec(
	z.object({ ok: z.boolean(), report: vaultHumanImportReport })
);

export const vaultHumanSnapshot = vaultMachineCodec(
	z.object({
		format: vaultHumanText,
		version: vaultHumanNumber,
		createdAt: vaultHumanText,
		kdf: vaultMachineCodec(
			z.object({
				alg: vaultHumanText,
				iterations: vaultHumanNumber,
				salt: vaultHumanText,
			})
		),
		nonce: vaultHumanText,
		ciphertext: vaultHumanText,
	})
);

const vaultHumanFinding = vaultMachineCodec(
	z.object({
		rule: vaultHumanText,
		description: vaultHumanText,
		source: vaultHumanText.optional(),
		line: vaultHumanNumber,
		column: vaultHumanNumber,
		preview: vaultHumanText,
		fingerprint: vaultHumanText,
		secret: vaultHumanText.optional(),
	})
);

export const vaultHumanFindings = vaultMachineCodec(
	z.object({ findings: z.array(vaultHumanFinding) })
);

const vaultHumanEnvironment = vaultMachineCodec(
	z.object({
		slug: vaultHumanText,
		name: vaultHumanText,
		protected: z.boolean(),
		requiredApprovals: vaultHumanNumber,
		position: vaultHumanNumber,
	})
);

export const vaultHumanEnvironments = vaultMachineCodec(
	z.object({
		environments: z.array(vaultHumanEnvironment),
		active: vaultHumanText,
	})
);

export const vaultHumanPutEnvironment = vaultMachineCodec(
	z.object({ ok: z.boolean(), environment: vaultHumanEnvironment })
);

export const vaultHumanDeleted = vaultMachineCodec(
	z.object({ ok: z.boolean(), deleted: z.boolean() })
);

export const vaultHumanFolders = vaultMachineCodec(
	z.object({ folders: z.array(vaultHumanText) })
);

export const vaultHumanCreatedFolder = vaultMachineCodec(
	z.object({ ok: z.boolean(), path: vaultHumanText })
);

const vaultHumanFolderImport = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		environment: vaultHumanText,
		path: vaultHumanText,
		sourceEnvironment: vaultHumanText,
		sourcePath: vaultHumanText,
		position: vaultHumanNumber,
	})
);

export const vaultHumanImports = vaultMachineCodec(
	z.object({ imports: z.array(vaultHumanFolderImport) })
);

export const vaultHumanAddedImport = vaultMachineCodec(
	z.object({ ok: z.boolean(), import: vaultHumanFolderImport })
);

export const vaultHumanRemoved = vaultMachineCodec(
	z.object({ ok: z.boolean(), removed: z.boolean() })
);

const vaultHumanPolicyRule = vaultMachineCodec(
	z.object({
		path: vaultHumanText,
		capabilities: vaultHumanCapabilities,
		deny: z.boolean(),
	})
);

const vaultHumanPolicy = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		description: vaultHumanText,
		rules: z.array(vaultHumanPolicyRule),
	})
);

const vaultHumanPolicyBinding = vaultMachineCodec(
	z.object({
		id: vaultHumanText,
		policy: vaultHumanText,
		subject: vaultHumanText,
		expiresAt: vaultHumanTimestamp.optional(),
	})
);

export const vaultHumanPolicies = vaultMachineCodec(
	z.object({
		policies: z.array(vaultHumanPolicy),
		bindings: z.array(vaultHumanPolicyBinding),
	})
);

export const vaultHumanPutPolicy = vaultMachineCodec(
	z.object({ ok: z.boolean(), policy: vaultHumanPolicy })
);

export const vaultHumanBoundPolicy = vaultMachineCodec(
	z.object({ ok: z.boolean(), binding: vaultHumanPolicyBinding })
);

export const vaultHumanChanges = vaultMachineCodec(
	z.object({
		changeRequests: z.array(vaultHumanChange),
		sharedError: vaultHumanText.nullable(),
	})
);

export const vaultHumanDecidedChange = vaultMachineCodec(
	z.object({ ok: z.boolean(), changeRequest: vaultHumanChange })
);

const vaultHumanAuditActor = vaultMachineCodec(
	z.object({ kind: vaultHumanText, id: vaultHumanText.nullable() })
);

const vaultHumanAuditEvent = vaultMachineCodec(
	z.object({
		seq: vaultHumanNumber,
		at: vaultHumanText,
		actor: vaultHumanAuditActor,
		action: vaultHumanText,
		outcome: vaultHumanText,
		scope: vaultHumanText.optional(),
		scopeId: vaultHumanText.optional(),
		environment: vaultHumanText.optional(),
		path: vaultHumanText.optional(),
		name: vaultHumanText.optional(),
		details: appJsonValueSchema,
		requestId: vaultHumanText.optional(),
	})
);

export const vaultHumanAudit = vaultMachineCodec(
	z.object({
		events: z.array(vaultHumanAuditEvent),
		nextBefore: vaultHumanNumber.nullable(),
	})
);

const vaultHumanAuditReport = vaultMachineCodec(
	z.object({
		ok: z.boolean(),
		rows: vaultHumanNumber,
		firstBadSeq: vaultHumanNumber.optional(),
	})
);

export const vaultHumanAuditVerified = vaultMachineCodec(
	z.object({ report: vaultHumanAuditReport })
);

export const vaultHumanStatus = vaultMachineCodec(
	z.object({
		seal: vaultHumanSeal,
		activeEnvironment: vaultHumanText,
		sharedRemote: z.boolean(),
	})
);

export const vaultHumanSealResponse = vaultMachineCodec(
	z.object({ seal: vaultHumanSeal })
);

export const vaultHumanShamirResponse = vaultMachineCodec(
	z.object({ shares: z.array(vaultHumanText), seal: vaultHumanSeal })
);

export const vaultHumanRotateResponse = vaultMachineCodec(
	z.object({
		keyVersion: vaultHumanNumber,
		rewrapped: vaultHumanNumber,
		seal: vaultHumanSeal,
	})
);

const vaultHumanMigrationFailure = vaultMachineCodec(
	z.object({
		key: vaultHumanText,
		error: vaultHumanText,
		conflict: z.boolean().optional(),
	})
);

export const vaultHumanMigration = vaultMachineCodec(
	z.object({
		ok: z.boolean(),
		moved: vaultHumanNumber,
		failed: z.array(vaultHumanMigrationFailure),
	})
);

const vaultHumanTransitKey = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		// Accept unknown types so a newer server's key types never break listing.
		type: vaultHumanText,
		latestVersion: vaultHumanNumber,
		minDecryptionVersion: vaultHumanNumber,
		minEncryptionVersion: vaultHumanNumber.optional(),
		minAvailableVersion: vaultHumanNumber.optional(),
		deletionAllowed: z.boolean(),
		derived: z.boolean().optional(),
		convergent: z.boolean().optional(),
		exportable: z.boolean().optional(),
		allowPlaintextBackup: z.boolean().optional(),
		autoRotatePeriodSecs: vaultHumanNumber.optional(),
		imported: z.boolean().optional(),
		createdAt: vaultHumanTimestamp,
		deletedAt: vaultHumanTimestamp.optional(),
		publicKeys: z.array(z.tuple([vaultHumanNumber, vaultHumanText])),
	})
);

export const vaultHumanTransitKeys = vaultMachineCodec(
	z.object({ keys: z.array(vaultHumanTransitKey) })
);

export const vaultHumanTransitKeyResponse = vaultMachineCodec(
	z.object({ key: vaultHumanTransitKey })
);

export const vaultHumanDeletedEngine = vaultMachineCodec(
	z.object({ deleted: z.boolean() })
);

export const vaultHumanTransitResponses: VaultHumanTransitCodecs = {
	...vaultMachineTransitResponses,
	rotate: vaultHumanTransitKeyResponse,
};

const vaultHumanPkiIssuer = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		commonName: vaultHumanText,
		certificate: vaultHumanText,
		notAfter: vaultHumanTimestamp,
	})
);

export const vaultHumanPkiIssuers = vaultMachineCodec(
	z.object({ issuers: z.array(vaultHumanPkiIssuer) })
);

export const vaultHumanPkiIssuerResponse = vaultMachineCodec(
	z.object({ issuer: vaultHumanPkiIssuer })
);

const vaultHumanPkiRole = vaultMachineCodec(
	z.object({
		name: vaultHumanText,
		issuer: vaultHumanText,
		allowedDomains: z.array(vaultHumanText),
		allowIpSans: z.boolean(),
		defaultTtlSecs: vaultHumanNumber,
		maxTtlSecs: vaultHumanNumber,
		serverFlag: z.boolean(),
		clientFlag: z.boolean(),
	})
);

export const vaultHumanPkiRoles = vaultMachineCodec(
	z.object({ roles: z.array(vaultHumanPkiRole) })
);

export const vaultHumanPkiRoleResponse = vaultMachineCodec(
	z.object({ role: vaultHumanPkiRole })
);

const vaultHumanPkiRecord = vaultMachineCodec(
	z.object({
		serial: vaultHumanText,
		issuer: vaultHumanText,
		commonName: vaultHumanText,
		notAfter: vaultHumanTimestamp,
		revokedAt: vaultHumanTimestamp.nullable(),
	})
);

export const vaultHumanPkiRecords = vaultMachineCodec(
	z.object({ certificates: z.array(vaultHumanPkiRecord) })
);

export const vaultHumanPkiRecordResponse = vaultMachineCodec(
	z.object({ certificate: vaultHumanPkiRecord })
);

const vaultHumanSshCa = vaultMachineCodec(
	z.object({ name: vaultHumanText, publicKey: vaultHumanText })
);

export const vaultHumanSshCas = vaultMachineCodec(
	z.object({ cas: z.array(vaultHumanSshCa) })
);
