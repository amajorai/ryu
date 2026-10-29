import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { A2aSettingsView } from "../../src/components/settings/A2aSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type {
	A2aPeer,
	A2aPeerCredential,
	A2aPrincipal,
	A2aPublishedAgent,
	A2aScope,
	A2aServerConfig,
	A2aTaskRecord,
	A2aTrust,
	PublishA2aAgentInput,
} from "../../src/lib/api/a2a.ts";
import type { AgentInput, AgentSummary } from "../../src/lib/api/agents.ts";
import { createAgent } from "../../src/lib/api/agents.ts";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJson,
} from "../fixture-json.ts";
import "../../src/index.css";

const STATE_KEY = "ryu:a2a-proof:state";
const FAILURES_KEY = "ryu:a2a-proof:failures";
const TARGET: ApiTarget = {
	token: null,
	url: window.location.origin,
	userJwt: null,
};
const FIXTURE_TIME = "2026-09-27T00:00:00.000Z";

// Closed request envelopes follow the actual A2A SDK. Domain-invalid values
// still reach the existing negative-response paths; malformed envelopes do not.
const scopeSchema = z.enum([
	"send",
	"read",
	"cancel",
	"subscribe",
	"push_config",
	"extended_card",
]);
const credentialSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z.object({ kind: z.literal("bearer"), token: z.string() }).strict(),
	z
		.object({
			kind: z.literal("api_key"),
			header: z.string(),
			value: z.string(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("basic"),
			password: z.string(),
			username: z.string(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("oauth2_client_credentials"),
			clientId: z.string(),
			clientSecret: z.string(),
			scopes: z.array(z.string()),
			tokenUrl: z.string(),
		})
		.strict(),
]) satisfies z.ZodType<A2aPeerCredential>;
const settingsWriteSchema = z
	.object({
		description: z.string(),
		displayName: z.string(),
		enabled: z.boolean(),
		exposeExtendedCard: z.boolean(),
		maxConcurrentTasks: z.number(),
		maxPayloadBytes: z.number(),
		publicBaseUrl: z.string().nullable(),
		tenantId: z.string(),
		updatedAt: z.string(),
	})
	.strict() satisfies z.ZodType<A2aServerConfig>;
const discoveryWriteSchema = z
	.object({
		credential: credentialSchema.optional(),
		name: z.string().optional(),
		url: z.string(),
	})
	.strict();
const trustWriteSchema = z
	.object({ trust: z.enum(["pending", "trusted", "revoked"]) })
	.strict();
const publishWriteSchema = z
	.object({
		agentId: z.string(),
		description: z.string(),
		enabled: z.boolean(),
		id: z.string().optional(),
		name: z.string(),
		skills: z.array(
			z
				.object({
					id: z.string(),
					description: z.string(),
					name: z.string(),
					tags: z.array(z.string()),
					examples: z.array(z.string()).optional(),
					inputModes: z.array(z.string()).optional(),
					outputModes: z.array(z.string()).optional(),
				})
				.strict()
		),
	})
	.strict() satisfies z.ZodType<PublishA2aAgentInput>;
const principalWriteSchema = z
	.object({ name: z.string(), scopes: z.array(scopeSchema) })
	.strict();
const remoteAgentWriteSchema = z
	.object({
		description: z.string().nullable(),
		engine: z.string().nullable(),
		// A remote peer keeps the default identity: it runs on its own node, and
		// Core lets only an unrestricted agent hand it work.
		identity_mode: z.literal("managed"),
		model: z.string().nullable(),
		name: z.string(),
		system_prompt: z.string().nullable(),
		title: z.string(),
		tools: z.array(z.string()),
	})
	.strict();

interface ProofState {
	agents: AgentSummary[];
	config: A2aServerConfig;
	peers: A2aPeer[];
	principals: A2aPrincipal[];
	published: A2aPublishedAgent[];
	tasks: A2aTaskRecord[];
}

interface ProofCall {
	body?: unknown;
	method: string;
	path: string;
}

interface ProofResponse {
	acknowledged: boolean;
	data: unknown;
	method: string;
	path: string;
	status: number;
}

interface QueryDiagnostic {
	data: unknown;
	fetchStatus: string;
	key: readonly unknown[];
	observers: number;
	status: string;
}

interface FailurePlan {
	error: string;
	method: string;
	path: string;
	status: number;
}

declare global {
	interface Window {
		__a2aProof: {
			calls: () => ProofCall[];
			failNext: (failure: FailurePlan) => void;
			invalidate: () => Promise<void>;
			queries: () => QueryDiagnostic[];
			responses: () => ProofResponse[];
			state: () => ProofState;
			unknownRequests: () => string[];
			unmount: () => void;
		};
	}
}

function initialAgents(): AgentSummary[] {
	return [
		{
			avatarGlyph: null,
			avatarUrl: null,
			builtIn: false,
			createdAt: FIXTURE_TIME,
			description: "Research across trusted sources",
			engine: "acp:pi",
			id: "agent-researcher",
			installHint: null,
			installed: true,
			latestVersion: null,
			lifecycleStatus: "active",
			locked: false,
			model: null,
			name: "Researcher",
			recommended: false,
			safetyProfile: "autonomous",
			systemPrompt: "Research carefully.",
			title: "Research",
			transport: null,
			version: "1.0.0",
			versionStatus: "current",
		},
	];
}

function initialState(): ProofState {
	const config: A2aServerConfig = {
		description: "Secure research and automation agents",
		displayName: "Ryu Studio",
		enabled: false,
		exposeExtendedCard: false,
		maxConcurrentTasks: 16,
		maxPayloadBytes: 1_048_576,
		publicBaseUrl: "https://agents.example.com",
		tenantId: "default",
		updatedAt: FIXTURE_TIME,
	};
	const peers: A2aPeer[] = [
		{
			agentCard: { name: "Hermes Research", version: "1.0" },
			agentCardUrl: "https://hermes.example.com/.well-known/agent-card.json",
			createdAt: FIXTURE_TIME,
			credentialConfigured: false,
			credentialKind: "none",
			enabled: true,
			id: "peer-hermes",
			lastError: null,
			name: "Hermes Research",
			tenantId: "default",
			trust: "pending",
			updatedAt: FIXTURE_TIME,
		},
	];
	const principals: A2aPrincipal[] = [
		{
			createdAt: FIXTURE_TIME,
			id: "principal-hermes",
			lastUsedAt: FIXTURE_TIME,
			name: "Hermes production",
			revokedAt: null,
			scopes: ["send", "read", "cancel", "subscribe"],
			tenantId: "default",
		},
	];
	const published: A2aPublishedAgent[] = [
		{
			agentId: "agent-legacy",
			createdAt: FIXTURE_TIME,
			description: "Previously published research agent",
			enabled: true,
			id: "published-legacy",
			name: "Legacy Analyst",
			skills: [
				{
					description: "Summarizes source material",
					id: "legacy-summary",
					name: "Source summary",
					tags: ["research"],
				},
			],
			tenantId: "default",
			updatedAt: FIXTURE_TIME,
		},
	];
	const tasks: A2aTaskRecord[] = [
		{
			contextId: "market-brief",
			createdAt: FIXTURE_TIME,
			direction: "outbound",
			id: "task-complete",
			localAgentId: "agent-researcher",
			ownerId: "local",
			peerId: "peer-hermes",
			protocolTask: {
				artifacts: [{ artifactId: "artifact-brief", name: "Brief" }],
				id: "task-market-brief",
			},
			revision: 4,
			state: "completed",
			tenantId: "default",
			updatedAt: FIXTURE_TIME,
		},
		{
			contextId: "review",
			createdAt: FIXTURE_TIME,
			direction: "inbound",
			id: "task-working",
			localAgentId: "agent-researcher",
			ownerId: "principal-hermes",
			peerId: null,
			protocolTask: { artifacts: [], id: "task-live-review" },
			revision: 1,
			state: "working",
			tenantId: "default",
			updatedAt: FIXTURE_TIME,
		},
	];
	return {
		agents: initialAgents(),
		config,
		peers,
		principals,
		published,
		tasks,
	};
}

const trustSchema = z.enum(["pending", "trusted", "revoked"]);
const skillSchema = z.object({
	description: z.string(),
	examples: z.array(z.string()).optional(),
	id: z.string(),
	inputModes: z.array(z.string()).optional(),
	name: z.string(),
	outputModes: z.array(z.string()).optional(),
	tags: z.array(z.string()),
});
const serverConfigSchema = z.object({
	description: z.string(),
	displayName: z.string(),
	enabled: z.boolean(),
	exposeExtendedCard: z.boolean(),
	maxConcurrentTasks: z.number(),
	maxPayloadBytes: z.number(),
	publicBaseUrl: z.string().nullable(),
	tenantId: z.string(),
	updatedAt: z.string(),
}) satisfies z.ZodType<A2aServerConfig>;
const credentialKindSchema = z.enum([
	"none",
	"bearer",
	"api_key",
	"basic",
	"oauth2_client_credentials",
]);
const agentSchema = z.object({
	avatarGlyph: z.null(),
	avatarUrl: z.string().nullable(),
	builtIn: z.boolean(),
	createdAt: z.string().nullable(),
	description: z.string().nullable(),
	engine: z.string().nullable(),
	id: z.string(),
	installed: z.boolean().nullable(),
	installHint: z.string().nullable(),
	latestVersion: z.string().nullable(),
	lifecycleStatus: z.enum(["draft", "trial", "active"]),
	locked: z.boolean(),
	model: z.string().nullable(),
	name: z.string(),
	recommended: z.boolean(),
	safetyProfile: z.enum([
		"read_only",
		"approval_required",
		"verified_plan_only",
		"autonomous",
	]),
	systemPrompt: z.string().nullable(),
	title: z.string(),
	transport: z.string().nullable(),
	version: z.string().nullable(),
	versionStatus: z.enum(["current", "behind_latest", "unknown"]).nullable(),
}) satisfies z.ZodType<AgentSummary>;
const stateSchema = z.object({
	agents: z.array(agentSchema),
	config: serverConfigSchema,
	peers: z.array(
		z.object({
			agentCard: z.record(z.string(), z.json()).nullable(),
			agentCardUrl: z.string(),
			createdAt: z.string(),
			credentialConfigured: z.boolean(),
			credentialKind: credentialKindSchema,
			enabled: z.boolean(),
			id: z.string(),
			lastError: z.string().nullable(),
			name: z.string(),
			tenantId: z.string(),
			trust: trustSchema,
			updatedAt: z.string(),
		})
	),
	principals: z.array(
		z.object({
			createdAt: z.string(),
			id: z.string(),
			lastUsedAt: z.string().nullable(),
			name: z.string(),
			revokedAt: z.string().nullable(),
			scopes: z.array(scopeSchema),
			tenantId: z.string(),
		})
	),
	published: z.array(
		z.object({
			agentId: z.string(),
			createdAt: z.string(),
			description: z.string(),
			enabled: z.boolean(),
			id: z.string(),
			name: z.string(),
			skills: z.array(skillSchema),
			tenantId: z.string(),
			updatedAt: z.string(),
		})
	),
	tasks: z.array(
		z.object({
			contextId: z.string(),
			createdAt: z.string(),
			direction: z.enum(["inbound", "outbound"]),
			id: z.string(),
			localAgentId: z.string().nullable(),
			ownerId: z.string(),
			peerId: z.string().nullable(),
			protocolTask: z.record(z.string(), z.json()),
			revision: z.number(),
			state: z.enum([
				"unknown",
				"submitted",
				"working",
				"input_required",
				"auth_required",
				"completed",
				"failed",
				"canceled",
				"rejected",
			]),
			tenantId: z.string(),
			updatedAt: z.string(),
		})
	),
}) satisfies z.ZodType<ProofState>;
const failuresSchema = z.array(
	z.object({
		error: z.string(),
		method: z.string(),
		path: z.string(),
		status: z.number(),
	})
) satisfies z.ZodType<FailurePlan[]>;
function readState(): ProofState {
	try {
		const raw = localStorage.getItem(STATE_KEY);
		if (raw) {
			return stateSchema.parse(JSON.parse(raw));
		}
	} catch {
		// A fresh fixture is safer than masking the rendered proof with corrupt data.
	}
	const state = initialState();
	writeState(state);
	return state;
}

function writeState(state: ProofState): void {
	localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function asRecord(value: ProofJsonValue | undefined): ProofJsonRecord {
	return z.record(z.string(), z.json()).safeParse(value).data ?? {};
}
function isScope(value: ProofJsonValue): value is A2aScope {
	return scopeSchema.safeParse(value).success;
}
function isTrust(value: ProofJsonValue | undefined): value is A2aTrust {
	return trustSchema.safeParse(value).success;
}

function toSummary(agent: {
	description: string | null;
	engine: string | null;
	id: string;
	model: string | null;
	name: string;
	title: string;
	system_prompt: string | null;
}): AgentSummary {
	return {
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: false,
		createdAt: FIXTURE_TIME,
		description: agent.description,
		engine: agent.engine,
		id: agent.id,
		installHint: null,
		installed: true,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: false,
		model: agent.model,
		name: agent.name,
		recommended: false,
		safetyProfile: "autonomous",
		systemPrompt: agent.system_prompt,
		title: agent.title,
		transport: null,
		version: "1.0.0",
		versionStatus: "current",
	};
}

function installFixture(): ProofCall[] {
	const calls: ProofCall[] = [];
	const responses: ProofResponse[] = [];
	const unknownRequests: string[] = [];
	window.__a2aProof = {
		calls: () => [...calls],
		failNext: (failure) => {
			const queued = failuresSchema.parse(
				JSON.parse(localStorage.getItem(FAILURES_KEY) ?? "[]")
			);
			queued.push(failure);
			localStorage.setItem(FAILURES_KEY, JSON.stringify(queued));
		},
		invalidate: () =>
			queryClient.invalidateQueries({ queryKey: ["a2a", TARGET.url] }),
		queries: () =>
			queryClient
				.getQueryCache()
				.findAll({ queryKey: ["a2a", TARGET.url] })
				.map((query) => ({
					data: structuredClone(query.state.data),
					fetchStatus: query.state.fetchStatus,
					key: [...query.queryKey],
					observers: query.getObserversCount(),
					status: query.state.status,
				})),
		responses: () => structuredClone(responses),
		state: () => readState(),
		unknownRequests: () => [...unknownRequests],
		unmount: () => renderer.unmount(),
	};

	const serveFixture = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.origin);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const refuse = (reason: string, status = 422) => {
			unknownRequests.push(`${method} ${url.href}: ${reason}`);
			return jsonResponse({ error: reason }, status);
		};
		if (url.origin !== TARGET.url) {
			return refuse("Unexpected A2A fixture authority", 403);
		}
		if (url.search !== "" || url.hash !== "") {
			return refuse("Undeclared A2A query or fragment");
		}
		let request: Request;
		try {
			request = new Request(input, init);
		} catch {
			return refuse("Invalid A2A native Request", 400);
		}
		if (
			request.headers.get("content-type") !== "application/json" ||
			request.headers.get("authorization") !== null ||
			request.headers.get("x-ryu-user-jwt") !== null ||
			request.headers.get("x-ryu-buyer-token") !== null ||
			!request.headers.get("x-ryu-client-id") ||
			request.headers.get("x-ryu-client-id") !==
				localStorage.getItem("ryu_client_id")
		) {
			return refuse("Undeclared A2A tokenless fixture headers", 401);
		}
		const raw = await request.text();
		let body: unknown;
		try {
			body = raw === "" ? undefined : parseProofJson(raw);
		} catch {
			return refuse("Malformed A2A JSON request", 400);
		}
		calls.push({ body, method, path: `${url.pathname}${url.search}` });
		const emptyRead =
			method === "GET" &&
			[
				"/api/a2a/settings",
				"/api/a2a/peers",
				"/api/a2a/published-agents",
				"/api/a2a/principals",
				"/api/a2a/tasks",
			].includes(url.pathname);
		const emptyDelete =
			method === "DELETE" &&
			/^\/api\/a2a\/(?:peers|published-agents|principals)\/[^/]+$/.test(
				url.pathname
			);
		const emptyCancel =
			method === "POST" &&
			/^\/api\/a2a\/tasks\/[^/]+\/cancel$/.test(url.pathname);
		if (emptyRead || emptyDelete || emptyCancel) {
			if (raw !== "") {
				return refuse("Undeclared A2A read/delete/cancel body");
			}
		} else {
			const schema =
				url.pathname === "/api/a2a/settings" && method === "PUT"
					? settingsWriteSchema
					: url.pathname === "/api/a2a/discover" && method === "POST"
						? discoveryWriteSchema
						: /^\/api\/a2a\/peers\/[^/]+\/trust$/.test(url.pathname) &&
								method === "PUT"
							? trustWriteSchema
							: url.pathname === "/api/a2a/published-agents" &&
									method === "POST"
								? publishWriteSchema
								: url.pathname === "/api/a2a/principals" && method === "POST"
									? principalWriteSchema
									: url.pathname === "/api/agents" && method === "POST"
										? remoteAgentWriteSchema
										: null;
			if (!schema) {
				return refuse("Undeclared A2A route or method", 404);
			}
			if (!schema.safeParse(body).success) {
				return refuse("Undeclared A2A write shape");
			}
		}
		let failures: FailurePlan[] = [];
		try {
			failures = failuresSchema.parse(
				JSON.parse(localStorage.getItem(FAILURES_KEY) ?? "[]")
			);
		} catch {
			failures = [];
		}
		const failedAt = failures.findIndex(
			(failure) => failure.method === method && failure.path === url.pathname
		);
		if (failedAt >= 0) {
			const [failure] = failures.splice(failedAt, 1);
			localStorage.setItem(FAILURES_KEY, JSON.stringify(failures));
			return jsonResponse({ error: failure.error }, failure.status);
		}

		const state = readState();
		const bodyRecord = asRecord(body);
		if (url.pathname === "/api/a2a/settings" && method === "GET") {
			return jsonResponse(state.config);
		}
		if (url.pathname === "/api/a2a/settings" && method === "PUT") {
			const enabled = bodyRecord.enabled;
			const concurrency = bodyRecord.maxConcurrentTasks;
			const payloadBytes = bodyRecord.maxPayloadBytes;
			const baseUrl = bodyRecord.publicBaseUrl;
			if (
				!(isNativeBoolean(enabled) && isNativeNumber(concurrency)) ||
				concurrency < 1 ||
				concurrency > 1024 ||
				!isNativeNumber(payloadBytes) ||
				payloadBytes < 1_048_576 ||
				payloadBytes > 16 * 1_048_576 ||
				(baseUrl !== null &&
					!(isNativeText(baseUrl) && baseUrl.startsWith("https://")))
			) {
				return jsonResponse({ error: "A2A settings validation failed" }, 422);
			}
			state.config = {
				...settingsWriteSchema.parse(body),
				updatedAt: FIXTURE_TIME,
			};
			writeState(state);
			return jsonResponse(state.config);
		}
		if (url.pathname === "/api/a2a/peers" && method === "GET") {
			return jsonResponse(state.peers);
		}
		if (url.pathname === "/api/a2a/discover" && method === "POST") {
			const peerUrl = isNativeText(bodyRecord.url) ? bodyRecord.url : "";
			if (!peerUrl.startsWith("https://")) {
				return jsonResponse({ error: "Peer URL must use HTTPS" }, 422);
			}
			const credential = credentialSchema.parse(
				bodyRecord.credential ?? { kind: "none" }
			);
			const kind = credential.kind;
			const peer: A2aPeer = {
				agentCard: { name: bodyRecord.name ?? "Fixture peer" },
				agentCardUrl: peerUrl.includes(".well-known")
					? peerUrl
					: `${peerUrl.replace(/\/$/, "")}/.well-known/agent-card.json`,
				createdAt: FIXTURE_TIME,
				credentialConfigured: kind !== "none",
				credentialKind: kind,
				enabled: true,
				id: `peer-${state.peers.length + 1}`,
				lastError: null,
				name:
					isNativeText(bodyRecord.name) && bodyRecord.name
						? bodyRecord.name
						: "Fixture peer",
				tenantId: "default",
				trust: "pending",
				updatedAt: FIXTURE_TIME,
			};
			state.peers = [...state.peers, peer];
			writeState(state);
			return jsonResponse(peer);
		}
		const trustMatch = url.pathname.match(
			/^\/api\/a2a\/peers\/([^/]+)\/trust$/
		);
		if (trustMatch && method === "PUT") {
			const trust = bodyRecord.trust;
			if (!isTrust(trust)) {
				return jsonResponse({ error: "Invalid trust value" }, 422);
			}
			const id = decodeURIComponent(trustMatch[1]);
			state.peers = state.peers.map((peer) =>
				peer.id === id ? { ...peer, trust, updatedAt: FIXTURE_TIME } : peer
			);
			writeState(state);
			return jsonResponse(state.peers.find((peer) => peer.id === id) ?? null);
		}
		const peerDeleteMatch = url.pathname.match(/^\/api\/a2a\/peers\/([^/]+)$/);
		if (peerDeleteMatch && method === "DELETE") {
			const id = decodeURIComponent(peerDeleteMatch[1]);
			state.peers = state.peers.filter((peer) => peer.id !== id);
			writeState(state);
			return jsonResponse({ deleted: true });
		}
		if (url.pathname === "/api/a2a/published-agents" && method === "GET") {
			return jsonResponse(state.published);
		}
		if (url.pathname === "/api/a2a/published-agents" && method === "POST") {
			const input = publishWriteSchema.parse(body);
			const agentId = isNativeText(bodyRecord.agentId)
				? bodyRecord.agentId
				: "";
			const existingId = isNativeText(bodyRecord.id)
				? bodyRecord.id
				: undefined;
			const existing = existingId
				? state.published.find((agent) => agent.id === existingId)
				: undefined;
			const record: A2aPublishedAgent = {
				agentId,
				createdAt: existing?.createdAt ?? FIXTURE_TIME,
				description: input.description,
				enabled: input.enabled,
				id: existingId ?? `published-${agentId}`,
				name: input.name,
				skills: input.skills,
				tenantId: "default",
				updatedAt: FIXTURE_TIME,
			};
			state.published = existing
				? state.published.map((agent) =>
						agent.id === record.id ? record : agent
					)
				: [...state.published, record];
			writeState(state);
			return jsonResponse(record);
		}
		const publishedDeleteMatch = url.pathname.match(
			/^\/api\/a2a\/published-agents\/([^/]+)$/
		);
		if (publishedDeleteMatch && method === "DELETE") {
			const id = decodeURIComponent(publishedDeleteMatch[1]);
			state.published = state.published.filter((agent) => agent.id !== id);
			writeState(state);
			return jsonResponse({ deleted: true });
		}
		if (url.pathname === "/api/a2a/principals" && method === "GET") {
			return jsonResponse(state.principals);
		}
		if (url.pathname === "/api/a2a/principals" && method === "POST") {
			const scopes = Array.isArray(bodyRecord.scopes)
				? bodyRecord.scopes.filter(isScope)
				: [];
			const principal: A2aPrincipal = {
				createdAt: FIXTURE_TIME,
				id: `principal-${state.principals.length + 1}`,
				lastUsedAt: null,
				name: String(bodyRecord.name ?? ""),
				revokedAt: null,
				scopes,
				tenantId: "default",
			};
			state.principals = [...state.principals, principal];
			writeState(state);
			return jsonResponse({
				principal,
				token: "ryu_a2a_one_time_fixture_token",
			});
		}
		const principalDeleteMatch = url.pathname.match(
			/^\/api\/a2a\/principals\/([^/]+)$/
		);
		if (principalDeleteMatch && method === "DELETE") {
			const id = decodeURIComponent(principalDeleteMatch[1]);
			state.principals = state.principals.map((principal) =>
				principal.id === id
					? { ...principal, revokedAt: FIXTURE_TIME }
					: principal
			);
			writeState(state);
			return jsonResponse({ revoked: true });
		}
		if (url.pathname === "/api/a2a/tasks" && method === "GET") {
			return jsonResponse(state.tasks);
		}
		const cancelMatch = url.pathname.match(
			/^\/api\/a2a\/tasks\/([^/]+)\/cancel$/
		);
		if (cancelMatch && method === "POST") {
			const id = decodeURIComponent(cancelMatch[1]);
			state.tasks = state.tasks.map((task) =>
				task.id === id
					? { ...task, state: "canceled", updatedAt: FIXTURE_TIME }
					: task
			);
			writeState(state);
			return jsonResponse({ cancelRequested: true });
		}
		if (url.pathname === "/api/agents" && method === "POST") {
			const agentId = "agent-remote-hermes";
			const agent = {
				built_in: false,
				created_at: FIXTURE_TIME,
				description: isNativeText(bodyRecord.description)
					? bodyRecord.description
					: null,
				engine: isNativeText(bodyRecord.engine) ? bodyRecord.engine : null,
				id: agentId,
				identity_mode: "managed",
				lifecycle_status: "active",
				name: String(bodyRecord.name ?? "Remote peer"),
				model: isNativeText(bodyRecord.model) ? bodyRecord.model : null,
				safety_profile: "autonomous",
				system_prompt: isNativeText(bodyRecord.system_prompt)
					? bodyRecord.system_prompt
					: null,
				title: String(bodyRecord.title ?? ""),
				tools: Array.isArray(bodyRecord.tools) ? bodyRecord.tools : [],
				updated_at: FIXTURE_TIME,
			};
			const summary = toSummary(agent);
			state.agents = [
				summary,
				...state.agents.filter((entry) => entry.id !== agentId),
			];
			writeState(state);
			return jsonResponse({ agent });
		}
		unknownRequests.push(`${method} ${url.pathname}${url.search}`);
		return jsonResponse(
			{ error: `Unhandled A2A proof request: ${method} ${url.pathname}` },
			404
		);
	};
	// Record the actual returned response while preserving its body for the
	// shipping transport. No query or business module is replaced here.
	window.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const response = await serveFixture(input, init);
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				window.location.origin
			);
			responses.push({
				acknowledged: response.ok,
				data: await response.clone().json(),
				method: (
					init?.method ?? (input instanceof Request ? input.method : "GET")
				).toUpperCase(),
				path: `${url.pathname}${url.search}`,
				status: response.status,
			});
			return response;
		},
		window.fetch
	);
	return calls;
}

function ProofSurface() {
	const [agents, setAgents] = useState(() => readState().agents);
	const agentRoster = {
		agents,
		create: async (input: AgentInput) => {
			const created = await createAgent(TARGET, input);
			setAgents((current) => {
				const summary = toSummary({
					description: created.description,
					engine: created.engine,
					id: created.id,
					model: created.model,
					name: created.name,
					title: created.title,
					system_prompt: created.systemPrompt,
				});
				return [summary, ...current.filter((agent) => agent.id !== summary.id)];
			});
			return created;
		},
	};
	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<I18nDirectionProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main className="min-h-dvh bg-background p-8 text-foreground">
							<div className="mx-auto max-w-4xl space-y-5">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Production component proof
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										Agent networking
									</h1>
									<p className="mt-2 text-muted-foreground text-sm">
										The production Desktop settings view calls its real A2A and
										agent API clients against a stateful local Core fixture.
									</p>
								</header>
								<A2aSettingsView agentRoster={agentRoster} />
							</div>
							<Toaster position="bottom-right" theme="dark" />
						</main>
					</ThemeProvider>
				</I18nDirectionProvider>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}

const node = {
	name: "a2a-proof",
	url: TARGET.url,
	token: null,
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: node.name,
	localNodes: [node],
	nodes: [node],
});
installFixture();

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("A2A proof root not found");
}
const renderer = createRoot(root);
renderer.render(
	<QueryClientProvider client={queryClient}>
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
