import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type ApiTarget, request } from "./client.ts";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";

export type A2aTrust = "pending" | "trusted" | "revoked";
export type A2aTaskDirection = "inbound" | "outbound";
export type A2aTaskState =
	| "unknown"
	| "submitted"
	| "working"
	| "input_required"
	| "auth_required"
	| "completed"
	| "failed"
	| "canceled"
	| "rejected";
export type A2aScope =
	| "send"
	| "read"
	| "cancel"
	| "subscribe"
	| "push_config"
	| "extended_card";

export interface A2aServerConfig {
	description: string;
	displayName: string;
	enabled: boolean;
	exposeExtendedCard: boolean;
	maxConcurrentTasks: number;
	maxPayloadBytes: number;
	publicBaseUrl: string | null;
	/** Refuse to discover peers whose Agent Card lacks a verified signature. */
	requireSignedPeerCards?: boolean;
	tenantId: string;
	updatedAt: string;
}

/** Outcome of checking a discovered Agent Card's JWS `signatures`. */
export type A2aCardSignature =
	| { status: "unsigned" }
	| { jku?: string; kid: string; status: "verified" }
	| { reason: string; status: "unverifiable" }
	| { reason: string; status: "invalid" };

export interface A2aPeer {
	agentCard: Record<string, GatewayJsonValue> | null;
	agentCardUrl: string;
	/** Absent for cards saved without discovery. */
	cardSignature?: A2aCardSignature | null;
	createdAt: string;
	credentialConfigured: boolean;
	credentialKind:
		| "none"
		| "bearer"
		| "api_key"
		| "basic"
		| "oauth2_client_credentials";
	enabled: boolean;
	id: string;
	lastError: string | null;
	name: string;
	tenantId: string;
	trust: A2aTrust;
	updatedAt: string;
}

export interface A2aAgentSkill {
	description: string;
	examples?: string[];
	id: string;
	inputModes?: string[];
	name: string;
	outputModes?: string[];
	tags: string[];
}

export interface A2aPublishedAgent {
	agentId: string;
	createdAt: string;
	description: string;
	enabled: boolean;
	id: string;
	name: string;
	skills: A2aAgentSkill[];
	tenantId: string;
	updatedAt: string;
}

export interface A2aPrincipal {
	createdAt: string;
	id: string;
	lastUsedAt: string | null;
	name: string;
	revokedAt: string | null;
	scopes: A2aScope[];
	tenantId: string;
}

export interface IssuedA2aToken {
	principal: A2aPrincipal;
	token: string;
}

export interface A2aTaskRecord {
	contextId: string;
	createdAt: string;
	direction: A2aTaskDirection;
	id: string;
	localAgentId: string | null;
	ownerId: string;
	peerId: string | null;
	protocolTask: Record<string, GatewayJsonValue>;
	revision: number;
	state: A2aTaskState;
	tenantId: string;
	updatedAt: string;
}

export type A2aPeerCredential =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { header: string; kind: "api_key"; value: string }
	| { kind: "basic"; password: string; username: string }
	| {
			clientId: string;
			clientSecret: string;
			kind: "oauth2_client_credentials";
			scopes: string[];
			tokenUrl: string;
	  };

export interface DiscoverA2aPeerInput {
	credential?: A2aPeerCredential;
	name?: string;
	url: string;
}

export interface PublishA2aAgentInput {
	agentId: string;
	description: string;
	enabled: boolean;
	id?: string;
	name: string;
	skills: A2aAgentSkill[];
}

export const getA2aSettings = (target: ApiTarget) =>
	request<A2aServerConfig>(
		target,
		"/api/a2a/settings",
		undefined,
		a2aServerConfigResponseCodec
	);

export const saveA2aSettings = (target: ApiTarget, config: A2aServerConfig) =>
	request<A2aServerConfig>(
		target,
		"/api/a2a/settings",
		{
			method: "PUT",
			body: config,
		},
		a2aServerConfigResponseCodec
	);

export const listA2aPeers = (target: ApiTarget) =>
	request<A2aPeer[]>(target, "/api/a2a/peers", undefined, responseCodec1);

export const discoverA2aPeer = (
	target: ApiTarget,
	input: DiscoverA2aPeerInput
) =>
	request<A2aPeer>(
		target,
		"/api/a2a/discover",
		{
			method: "POST",
			body: input,
		},
		a2aPeerResponseCodec
	);

export const setA2aPeerTrust = (
	target: ApiTarget,
	id: string,
	trust: A2aTrust
) =>
	request<A2aPeer>(
		target,
		`/api/a2a/peers/${encodeURIComponent(id)}/trust`,
		{
			method: "PUT",
			body: { trust },
		},
		a2aPeerResponseCodec
	);

export const deleteA2aPeer = (target: ApiTarget, id: string) =>
	request<{ deleted: boolean }>(
		target,
		`/api/a2a/peers/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		responseCodec2
	);

export const listA2aPrincipals = (target: ApiTarget) =>
	request<A2aPrincipal[]>(
		target,
		"/api/a2a/principals",
		undefined,
		responseCodec3
	);

export const issueA2aPrincipal = (
	target: ApiTarget,
	name: string,
	scopes: A2aScope[]
) =>
	request<IssuedA2aToken>(
		target,
		"/api/a2a/principals",
		{
			method: "POST",
			body: { name, scopes },
		},
		issuedA2aTokenResponseCodec
	);

export const revokeA2aPrincipal = (target: ApiTarget, id: string) =>
	request<{ revoked: boolean }>(
		target,
		`/api/a2a/principals/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		responseCodec4
	);

export const listPublishedA2aAgents = (target: ApiTarget) =>
	request<A2aPublishedAgent[]>(
		target,
		"/api/a2a/published-agents",
		undefined,
		responseCodec5
	);

export const publishA2aAgent = (
	target: ApiTarget,
	input: PublishA2aAgentInput
) =>
	request<A2aPublishedAgent>(
		target,
		"/api/a2a/published-agents",
		{
			method: "POST",
			body: input,
		},
		a2aPublishedAgentResponseCodec
	);

export const deletePublishedA2aAgent = (target: ApiTarget, id: string) =>
	request<{ deleted: boolean }>(
		target,
		`/api/a2a/published-agents/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		responseCodec6
	);

export const listA2aTasks = (target: ApiTarget) =>
	request<A2aTaskRecord[]>(target, "/api/a2a/tasks", undefined, responseCodec7);

export const cancelA2aTask = (target: ApiTarget, id: string) =>
	request<{ cancelRequested: boolean }>(
		target,
		`/api/a2a/tasks/${encodeURIComponent(id)}/cancel`,
		{ method: "POST" },
		responseCodec8
	);

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const a2aServerConfigResponseCodec = z
	.object({
		description: z.string(),
		displayName: z.string(),
		enabled: z.boolean(),
		exposeExtendedCard: z.boolean(),
		maxConcurrentTasks: z.number(),
		maxPayloadBytes: z.number(),
		publicBaseUrl: z.union([z.string(), z.null()]),
		tenantId: z.string(),
		updatedAt: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const a2aTrustResponseCodec = z.union([
	z.literal("pending"),
	z.literal("trusted"),
	z.literal("revoked"),
]);
const a2aPeerResponseCodec = z
	.object({
		agentCard: z.union([
			z.record(z.string(), gatewayJsonValueSchema),
			z.null(),
		]),
		agentCardUrl: z.string(),
		createdAt: z.string(),
		credentialConfigured: z.boolean(),
		credentialKind: z.union([
			z.literal("none"),
			z.literal("bearer"),
			z.literal("api_key"),
			z.literal("basic"),
			z.literal("oauth2_client_credentials"),
		]),
		enabled: z.boolean(),
		id: z.string(),
		lastError: z.union([z.string(), z.null()]),
		name: z.string(),
		tenantId: z.string(),
		trust: a2aTrustResponseCodec,
		updatedAt: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z.array(a2aPeerResponseCodec);
const responseCodec2 = z
	.object({ deleted: z.boolean() })
	.catchall(gatewayJsonValueSchema);
const a2aScopeResponseCodec = z.union([
	z.literal("send"),
	z.literal("read"),
	z.literal("cancel"),
	z.literal("subscribe"),
	z.literal("push_config"),
	z.literal("extended_card"),
]);
const a2aPrincipalResponseCodec = z
	.object({
		createdAt: z.string(),
		id: z.string(),
		lastUsedAt: z.union([z.string(), z.null()]),
		name: z.string(),
		revokedAt: z.union([z.string(), z.null()]),
		scopes: z.array(a2aScopeResponseCodec),
		tenantId: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec3 = z.array(a2aPrincipalResponseCodec);
const issuedA2aTokenResponseCodec = z
	.object({ principal: a2aPrincipalResponseCodec, token: z.string() })
	.catchall(gatewayJsonValueSchema);
const responseCodec4 = z
	.object({ revoked: z.boolean() })
	.catchall(gatewayJsonValueSchema);
const a2aAgentSkillResponseCodec = z
	.object({
		description: z.string(),
		examples: z.array(z.string()).optional(),
		id: z.string(),
		inputModes: z.array(z.string()).optional(),
		name: z.string(),
		outputModes: z.array(z.string()).optional(),
		tags: z.array(z.string()),
	})
	.catchall(gatewayJsonValueSchema);
const a2aPublishedAgentResponseCodec = z
	.object({
		agentId: z.string(),
		createdAt: z.string(),
		description: z.string(),
		enabled: z.boolean(),
		id: z.string(),
		name: z.string(),
		skills: z.array(a2aAgentSkillResponseCodec),
		tenantId: z.string(),
		updatedAt: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec5 = z.array(a2aPublishedAgentResponseCodec);
const responseCodec6 = z
	.object({ deleted: z.boolean() })
	.catchall(gatewayJsonValueSchema);
const a2aTaskDirectionResponseCodec = z.union([
	z.literal("inbound"),
	z.literal("outbound"),
]);
const a2aTaskStateResponseCodec = z.union([
	z.literal("unknown"),
	z.literal("submitted"),
	z.literal("working"),
	z.literal("input_required"),
	z.literal("auth_required"),
	z.literal("completed"),
	z.literal("failed"),
	z.literal("canceled"),
	z.literal("rejected"),
]);
const a2aTaskRecordResponseCodec = z
	.object({
		contextId: z.string(),
		createdAt: z.string(),
		direction: a2aTaskDirectionResponseCodec,
		id: z.string(),
		localAgentId: z.union([z.string(), z.null()]),
		ownerId: z.string(),
		peerId: z.union([z.string(), z.null()]),
		protocolTask: z.record(z.string(), gatewayJsonValueSchema),
		revision: z.number(),
		state: a2aTaskStateResponseCodec,
		tenantId: z.string(),
		updatedAt: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec7 = z.array(a2aTaskRecordResponseCodec);
const responseCodec8 = z
	.object({ cancelRequested: z.boolean() })
	.catchall(gatewayJsonValueSchema);
