// packages/core-client/src/vault/dynamic.ts
//
// Dynamic secrets and leases: part of the Secret Vault client. `../vault.ts`
// re-exports these names and documents the wire conventions.

import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";
import { vaultHumanDeletedEngine } from "./codecs-human.ts";
import {
	vaultHumanDynamicRoleResponse,
	vaultHumanDynamicRoles,
	vaultHumanLeases,
	vaultHumanRevokedCount,
} from "./codecs-human-engines.ts";
import {
	vaultMachineDynamicResponse,
	vaultMachineLeaseResponse,
} from "./codecs-machine.ts";
import { query } from "./internal.ts";
import type { VaultCharset, VaultTimestamp } from "./shared.ts";

export type VaultDynamicProvider =
	| {
			connectionUrl: string;
			creationStatements: string[];
			kind: "postgres";
			revocationStatements?: string[];
			usernamePrefix?: string;
			usernameTemplate?: string;
	  }
	| {
			accessKeyId: string;
			endpoint?: string;
			kind: "aws-sts";
			region: string;
			roleArn: string;
			secretAccessKey: string;
			sessionPolicy?: string;
	  }
	| {
			connectionUrl: string;
			creationStatements: string[];
			kind: "mysql" | "mariadb";
			revocationStatements?: string[];
			usernamePrefix?: string;
			usernameTemplate?: string;
	  }
	| {
			/** PEM CA for the server certificate (configuration managers only). */
			caPem?: string;
			/** `sqlserver://…?encrypt=true|strict|false`. */
			connectionUrl: string;
			creationStatements: string[];
			kind: "mssql";
			revocationStatements?: string[];
			usernamePrefix?: string;
			usernameTemplate?: string;
	  }
	| {
			connectionUrl: string;
			/** Database the users are created in (default `admin`). */
			database?: string;
			kind: "mongodb";
			roles: { db?: string; role: string }[];
			usernamePrefix?: string;
			usernameTemplate?: string;
	  }
	| {
			/** Service-account key JSON of the account Ryu acts as. */
			credentials: string;
			kind: "gcp";
			secretType?: "serviceAccountKey" | "accessToken";
			serviceAccountEmail: string;
			tokenScopes?: string[];
	  }
	| {
			applicationObjectId: string;
			clientId: string;
			clientSecret: string;
			environment?: "public" | "usGovernment" | "china";
			kind: "azure";
			tenantId: string;
	  }
	| {
			audiences?: string[];
			/** PEM CA for the API server (configuration managers only). */
			caPem?: string;
			clusterRoleBinding?: boolean;
			host: string;
			kind: "kubernetes";
			/** Generate an account per lease bound to this role… */
			kubernetesRoleName?: string;
			kubernetesRoleType?: "Role" | "ClusterRole";
			namespace: string;
			/** …or mint tokens for this existing account. */
			serviceAccountName?: string;
			serviceAccountJwt: string;
			usernamePrefix?: string;
	  }
	| {
			audiences?: string[];
			caPem?: string;
			clusterRoleBinding?: boolean;
			host: string;
			kind: "kubernetes-rules";
			kubernetesRoleType?: "Role" | "ClusterRole";
			namespace: string;
			/** RBAC PolicyRule objects for the Role generated per lease. */
			rules: {
				apiGroups?: string[];
				nonResourceURLs?: string[];
				resourceNames?: string[];
				resources?: string[];
				verbs: string[];
			}[];
			serviceAccountJwt: string;
			usernamePrefix?: string;
	  }
	| {
			accessKeyId: string;
			endpoint?: string;
			iamGroups?: string[];
			kind: "aws-iam";
			permissionsBoundaryArn?: string;
			policyArns?: string[];
			/** Inline policy JSON put on each generated user. */
			policyDocument?: string;
			region?: string;
			secretAccessKey: string;
			userPath?: string;
			usernamePrefix?: string;
	  }
	| {
			caPem?: string;
			/** Management API base, e.g. `https://rabbit.example.com:15671`. */
			connectionUri: string;
			kind: "rabbitmq";
			password: string;
			tags?: string;
			username: string;
			usernamePrefix?: string;
			vhostTopics?: Record<
				string,
				Record<string, { read?: string; write?: string }>
			>;
			vhosts: Record<
				string,
				{ configure?: string; read?: string; write?: string }
			>;
	  }
	| {
			aclRules?: string[];
			connectionUrl: string;
			kind: "redis" | "valkey";
			usernamePrefix?: string;
			usernameTemplate?: string;
	  }
	| { kind: "webhook"; signingSecret: string; url: string }
	| { charset: VaultCharset; field?: string; kind: "random"; length: number };

export interface VaultDynamicRole {
	createdAt: VaultTimestamp;
	defaultTtlSecs: number;
	maxTtlSecs: number;
	name: string;
	provider: string;
	/** Provider configuration with credentials redacted. */
	summary: AppJsonValue;
	updatedAt: VaultTimestamp;
}

export interface VaultLease {
	createdAt: VaultTimestamp;
	expiresAt: VaultTimestamp;
	id: string;
	issuedTo: string | null;
	maxExpiresAt: VaultTimestamp;
	provider: string;
	renewable: boolean;
	revokedAt: VaultTimestamp | null;
	role: string;
}

export interface VaultDynamicCredential {
	/** The credential, returned once. */
	data: Record<string, string>;
	lease: VaultLease;
}

export function listVaultDynamicRoles(
	target: ApiTarget
): Promise<{ roles: VaultDynamicRole[] }> {
	return request(
		target,
		"/api/vault/dynamic/roles",
		{},
		vaultHumanDynamicRoles
	);
}

export function putVaultDynamicRole(
	target: ApiTarget,
	name: string,
	input: {
		defaultTtlSecs?: number;
		maxTtlSecs?: number;
		provider: VaultDynamicProvider;
	}
): Promise<{ role: VaultDynamicRole }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			body: input,
		},
		vaultHumanDynamicRoleResponse
	);
}

export function deleteVaultDynamicRole(
	target: ApiTarget,
	name: string
): Promise<{ deleted: boolean }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
		vaultHumanDeletedEngine
	);
}

export function revokeAllVaultDynamicLeases(
	target: ApiTarget,
	name: string
): Promise<{ revoked: number }> {
	return request(
		target,
		`/api/vault/dynamic/roles/${encodeURIComponent(name)}/revoke-all`,
		{ method: "POST" },
		vaultHumanRevokedCount
	);
}

export function issueVaultDynamicCredential(
	target: ApiTarget,
	role: string,
	ttlSecs?: number
): Promise<{ credential: VaultDynamicCredential }> {
	return request(
		target,
		`/api/vault/dynamic/issue/${encodeURIComponent(role)}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		},
		vaultMachineDynamicResponse
	);
}

export function listVaultLeases(
	target: ApiTarget,
	filter: { includeRevoked?: boolean; role?: string } = {}
): Promise<{ leases: VaultLease[] }> {
	return request(
		target,
		`/api/vault/leases${query({ role: filter.role, includeRevoked: filter.includeRevoked })}`,
		{},
		vaultHumanLeases
	);
}

export function vaultLease(
	target: ApiTarget,
	id: string,
	op: "renew" | "revoke",
	ttlSecs?: number
): Promise<{ lease: VaultLease }> {
	return request(
		target,
		`/api/vault/leases/${encodeURIComponent(id)}/${op}`,
		{
			method: "POST",
			body: ttlSecs === undefined ? {} : { ttlSecs },
		},
		vaultMachineLeaseResponse
	);
}
