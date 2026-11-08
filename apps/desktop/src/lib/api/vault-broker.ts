// Credential broker services, catalog templates and proposals
// (`/api/vault/broker/*`). Services and proposals carry hosts and `secret:`
// references, never values. Writing a service needs `admin` on its
// `sys/broker/<name>` key and `use` on every credential it names; Core checks
// both and answers `vault_denied` otherwise.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import type { VaultPasswordManagerGrantMode } from "@ryuhq/core-client/vault.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { vaultQueryString } from "./vault-query.ts";

/** Where a placeholder may be substituted. */
export type VaultBrokerSurface =
	| "header"
	| "query"
	| "path"
	| "body"
	| "websocket";

/** How the broker authenticates a matched request. Credential fields hold
 *  `secret:` or password-manager references, never values. */
export type VaultBrokerAuth =
	| { token: string; type: "bearer" }
	| { password: string; type: "basic"; username: string }
	| { header: string; prefix?: string; type: "api_key"; value: string }
	| { headers: Record<string, string>; type: "custom" }
	| { type: "passthrough" }
	| ({ type: "oauth" } & Record<string, unknown>);

export type VaultBrokerAuthType = VaultBrokerAuth["type"];

export interface VaultBrokerSubstitution {
	in: VaultBrokerSurface[];
	placeholder: string;
	ref: string;
}

/** The body Core takes to create or replace a service. */
export interface VaultBrokerServiceInput {
	allowInsecureHttp?: boolean;
	auth: VaultBrokerAuth;
	/** Relay into cloud-task Boxes. Kept as-is by the editor, which does not author it. */
	boxRelay?: boolean;
	description?: string;
	enabled: boolean;
	environment: string;
	host: string;
	name: string;
	notes?: string;
	pathPrefix: string;
	port?: number;
	substitutions?: VaultBrokerSubstitution[];
}

export interface VaultBrokerService
	extends Omit<VaultBrokerServiceInput, "auth"> {
	/** Absent only on replies from nodes that predate auth in listings. */
	auth?: VaultBrokerAuth;
	createdAt: string;
	updatedAt: string;
}

/** Instantiate a catalog template, optionally under another name or
 *  credential reference. */
export interface VaultBrokerTemplateInput {
	credentialRef?: string;
	environment: string;
	name?: string;
	template: string;
}

export interface VaultBrokerTemplate {
	auth: VaultBrokerAuth;
	host: string;
	id: string;
	name: string;
	pathPrefix: string;
	suggestedRef: string;
}

export interface VaultBrokerProposal {
	createdAt: string;
	credentials: { description?: string; ref: string }[];
	/** Set on a password-manager credential-use request: the first use of an
	 *  `op://` / `bws://` reference by `subject`. */
	credentialUse?: {
		account: string;
		provider: string;
		ref: string;
		subject: string;
	};
	environment: string;
	expiresAt: string;
	id: string;
	message: string;
	requestedBy: string;
	services: { host?: string; name?: string }[];
	status: "pending" | "approved" | "rejected" | "expired";
}

const surfaceSchema = z.enum(["header", "query", "path", "body", "websocket"]);

const authSchema: z.ZodType<VaultBrokerAuth> = z.union([
	z.object({ token: z.string(), type: z.literal("bearer") }),
	z.object({
		password: z.string(),
		type: z.literal("basic"),
		username: z.string(),
	}),
	z.object({
		header: z.string(),
		prefix: z.string().optional(),
		type: z.literal("api_key"),
		value: z.string(),
	}),
	z.object({
		headers: z.record(z.string(), z.string()),
		type: z.literal("custom"),
	}),
	z.object({ type: z.literal("passthrough") }),
	z.object({ type: z.literal("oauth") }).catchall(z.unknown()),
]);

const serviceSchema = z
	.object({
		allowInsecureHttp: z.boolean().optional(),
		auth: authSchema.optional(),
		createdAt: z.string(),
		description: z.string().optional(),
		enabled: z.boolean(),
		environment: z.string(),
		host: z.string(),
		name: z.string(),
		notes: z.string().optional(),
		pathPrefix: z.string(),
		port: z.number().optional(),
		substitutions: z
			.array(
				z.object({
					in: z.array(surfaceSchema),
					placeholder: z.string(),
					ref: z.string(),
				})
			)
			.optional(),
		updatedAt: z.string(),
	})
	.passthrough();

const serviceReplySchema = z.object({ service: serviceSchema }).passthrough();

const listServicesSchema = z
	.object({ services: z.array(serviceSchema).optional() })
	.passthrough();

const catalogSchema = z
	.object({
		templates: z
			.array(
				z
					.object({
						auth: authSchema,
						host: z.string(),
						id: z.string(),
						name: z.string(),
						pathPrefix: z.string(),
						suggestedRef: z.string(),
					})
					.passthrough()
			)
			.optional(),
	})
	.passthrough();

const proposalSchema = z
	.object({
		createdAt: z.string(),
		credentials: z.array(
			z
				.object({ description: z.string().optional(), ref: z.string() })
				.passthrough()
		),
		credentialUse: z
			.object({
				account: z.string(),
				provider: z.string(),
				ref: z.string(),
				subject: z.string(),
			})
			.passthrough()
			.optional(),
		environment: z.string(),
		expiresAt: z.string(),
		id: z.string(),
		message: z.string(),
		requestedBy: z.string(),
		services: z.array(
			z
				.object({ host: z.string().optional(), name: z.string().optional() })
				.passthrough()
		),
		status: z.enum(["pending", "approved", "rejected", "expired"]),
	})
	.passthrough();

const listProposalsSchema = z
	.object({ proposals: z.array(proposalSchema).optional() })
	.passthrough();

const deletedSchema = z.object({ deleted: z.boolean() }).passthrough();

function servicePath(name: string): string {
	return `/api/vault/broker/services/${encodeURIComponent(name)}`;
}

/** Services the caller holds any capability on, across environments unless
 *  `environment` is given. */
export async function listVaultBrokerServices(
	target: ApiTarget,
	environment?: string
): Promise<VaultBrokerService[]> {
	const raw = await request(
		target,
		`/api/vault/broker/services${vaultQueryString({ environment })}`,
		undefined,
		listServicesSchema
	);
	return raw?.services ?? [];
}

/** Create a service from a full definition or a catalog template. */
export async function createVaultBrokerService(
	target: ApiTarget,
	input: VaultBrokerServiceInput | VaultBrokerTemplateInput
): Promise<VaultBrokerService> {
	const raw = await request(
		target,
		"/api/vault/broker/services",
		{ body: input, method: "POST" },
		serviceReplySchema
	);
	return raw.service;
}

/** Replace a service. The name in the path wins over `input.name`. */
export async function updateVaultBrokerService(
	target: ApiTarget,
	name: string,
	input: VaultBrokerServiceInput
): Promise<VaultBrokerService> {
	const raw = await request(
		target,
		servicePath(name),
		{ body: { ...input, name }, method: "PUT" },
		serviceReplySchema
	);
	return raw.service;
}

/** `false` when no such service existed. */
export async function deleteVaultBrokerService(
	target: ApiTarget,
	name: string
): Promise<boolean> {
	const raw = await request(
		target,
		servicePath(name),
		{ method: "DELETE" },
		deletedSchema
	);
	return raw.deleted;
}

export async function listVaultBrokerCatalog(
	target: ApiTarget
): Promise<VaultBrokerTemplate[]> {
	const raw = await request(
		target,
		"/api/vault/broker/catalog",
		undefined,
		catalogSchema
	);
	return raw?.templates ?? [];
}

export async function listVaultBrokerProposals(
	target: ApiTarget
): Promise<VaultBrokerProposal[]> {
	const raw = await request(
		target,
		`/api/vault/broker/proposals${vaultQueryString({ status: "pending" })}`,
		undefined,
		listProposalsSchema
	);
	return raw?.proposals ?? [];
}

/** Approving creates the proposed services. Requested credentials are stored
 *  separately (in the Secrets tab), so the page sends no values. Approving a
 *  password-manager credential-use request records a grant for `grant`
 *  (Core defaults to 30 days). */
export async function decideVaultBrokerProposal(
	target: ApiTarget,
	id: string,
	decision: "approve" | "reject",
	grant?: VaultPasswordManagerGrantMode
): Promise<void> {
	await request(
		target,
		`/api/vault/broker/proposals/${encodeURIComponent(id)}/${decision}`,
		{ body: decision === "approve" && grant ? { grant } : {}, method: "POST" },
		appResponseValueSchema
	);
}
