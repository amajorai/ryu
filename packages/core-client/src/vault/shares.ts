// packages/core-client/src/vault/shares.ts
//
// One-time share links and inbound secret-request links: part of the Secret
// Vault client. A share link's URL carries its decryption key in the
// `#fragment` and is returned once; it is never stored or listed.

import { z } from "zod";
import type { AppJsonValue } from "../app-request-json.ts";
import { type ApiTarget, request } from "../client.ts";

export interface VaultShareLinkCreated {
	expiresAt: string;
	id: string;
	/** Returned once. For a share, the fragment is the key. */
	url: string;
}

export interface VaultShareLink {
	createdAt: string | number;
	createdBy: string | null;
	expiresAt: string | number;
	id: string;
	kind: "share" | "request";
	label: string | null;
	/** `open`, `claimed`, or `revoked` as the node knows it. */
	status: string;
	target: AppJsonValue | null;
}

export interface VaultShareCoords {
	environment?: string;
	path?: string;
	scope?: "user" | "node" | "team" | "org" | "project";
	scopeId?: string;
}

const createdSchema = z.object({
	expiresAt: z.string(),
	id: z.string(),
	url: z.string(),
});
const linkResponse = z.object({ link: createdSchema });
type LinkResponse = z.infer<typeof linkResponse>;
const linksResponse = z.object({
	links: z.array(
		z.object({
			createdAt: z.union([z.string(), z.number()]),
			createdBy: z.string().nullable(),
			expiresAt: z.union([z.string(), z.number()]),
			id: z.string(),
			kind: z.enum(["share", "request"]),
			label: z.string().nullable(),
			status: z.string(),
			target: z.custom<AppJsonValue>().nullable(),
		})
	),
});
const revokedResponse = z.object({ revoked: z.boolean() });
const anyResponse = z.custom<AppJsonValue>();

/** Share a vault value (`read`) once. */
export function shareVaultSecret(
	target: ApiTarget,
	name: string,
	options: VaultShareCoords & {
		label?: string;
		ttlSecs?: number;
		version?: number;
	} = {}
): Promise<LinkResponse> {
	return request(
		target,
		"/api/vault/shares",
		{ method: "POST", body: { name, ...options } },
		linkResponse
	);
}

/** Turn a wrapping token into a share link (consumes the token). */
export function shareVaultWrapToken(
	target: ApiTarget,
	wrapToken: string,
	options: { label?: string; ttlSecs?: number } = {}
): Promise<LinkResponse> {
	return request(
		target,
		"/api/vault/shares",
		{ method: "POST", body: { wrapToken, ...options } },
		linkResponse
	);
}

/** Ask someone for a value to be written to `name` (`write`). */
export function requestVaultSecret(
	target: ApiTarget,
	name: string,
	label: string,
	options: VaultShareCoords & { ttlSecs?: number } = {}
): Promise<LinkResponse> {
	return request(
		target,
		"/api/vault/share-requests",
		{ method: "POST", body: { name, label, ...options } },
		linkResponse
	);
}

export interface VaultCredentialRequestOptions {
	/** The agent the sign-in is saved for (its own accounts folder). */
	agentId?: string;
	/** Login URLs a session Box fill may submit the password to. */
	submitUrls?: string[];
	/** Also offer a field for an authenticator setup key. */
	totp?: boolean;
	ttlSecs?: number;
	/** A username to prefill on the page. */
	username?: string;
}

/**
 * Ask someone for an agent's sign-in to `site`. Claiming the answer saves an
 * agent account; nobody but the browser that fills it sees the password.
 */
export function requestVaultCredential(
	target: ApiTarget,
	site: string,
	label: string,
	options: VaultCredentialRequestOptions = {}
): Promise<LinkResponse> {
	return request(
		target,
		"/api/vault/credential-requests",
		{ method: "POST", body: { site, label, ...options } },
		linkResponse
	);
}

export function listVaultShareLinks(
	target: ApiTarget
): Promise<{ links: VaultShareLink[] }> {
	return request(target, "/api/vault/shares", {}, linksResponse);
}

/** Write a request's answer to its vault key. */
export function claimVaultShareRequest(
	target: ApiTarget,
	id: string
): Promise<AppJsonValue> {
	return request(
		target,
		`/api/vault/shares/${encodeURIComponent(id)}/claim`,
		{ method: "POST" },
		anyResponse
	);
}

export function revokeVaultShareLink(
	target: ApiTarget,
	id: string
): Promise<{ revoked: boolean }> {
	return request(
		target,
		`/api/vault/shares/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		revokedResponse
	);
}
