import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/composio.ts
//
// Typed client for Core's Composio endpoints (`/api/composio/*`). Core uses the
// user's configured Composio key (Gateway → Keys) to browse the catalog
// (toolkits/actions/triggers) and to manage the user's connected accounts. Tool
// execution itself happens in the gateway; this client browses descriptors for
// the agent editor's pickers and drives the Marketplace → Connections tab
// (list/initiate/poll a connection).

import {
	type ConnectionAccessLevel,
	DEFAULT_CONNECTION_ACCESS_LEVEL,
	normalizeConnectionAccessLevel,
} from "../connection-permissions.ts";
import { ApiError, type ApiTarget, request } from "./client.ts";

/** Whether a Composio key is configured + the active REST base. */
export interface ComposioStatus {
	baseUrl: string;
	configured: boolean;
	executionOwner?: "connect";
}

/** A Composio toolkit (an integration like GitHub, Gmail, Slack). */
export interface ComposioToolkit {
	description: string | null;
	logo: string | null;
	name: string;
	slug: string;
}

/** A Composio action (a callable tool within a toolkit). */
export interface ComposioAction {
	description: string | null;
	displayName: string;
	inputSchema: ComposioInputSchema;
	name: string;
	noAuth: boolean;
	tags: string[];
	toolkit: string;
}

export interface ComposioInputProperty {
	default?: unknown;
	description?: string;
	enum?: unknown[];
	title?: string;
	type?: string | string[];
}

export interface ComposioInputSchema {
	properties?: Record<string, ComposioInputProperty>;
	required?: string[];
	type?: string;
}

/** A Composio trigger type (an event a toolkit can fire). */
export interface ComposioTrigger {
	description: string | null;
	displayName: string;
	name: string;
	toolkit: string;
}

interface ToolkitWire {
	description?: string | null;
	logo?: string | null;
	name?: string;
	slug?: string;
}

interface ActionWire {
	description?: string | null;
	display_name?: string;
	input_schema?: ComposioInputSchema;
	name?: string;
	no_auth?: boolean;
	tags?: unknown;
	toolkit?: string;
}

interface TriggerWire {
	description?: string | null;
	display_name?: string;
	name?: string;
	toolkit?: string;
}

export async function fetchComposioStatus(
	target: ApiTarget
): Promise<ComposioStatus> {
	const json = await request<{
		configured?: boolean;
		base_url?: string;
		execution_owner?: string;
	}>(target, "/api/composio/status", {}, fetchComposioStatusResponseSchema);
	return {
		configured: json.configured ?? false,
		baseUrl: json.base_url ?? "",
		...(json.execution_owner === "connect"
			? { executionOwner: "connect" as const }
			: undefined),
	};
}

export async function fetchComposioToolkits(
	target: ApiTarget
): Promise<ComposioToolkit[]> {
	const json = await request<{ data?: ToolkitWire[] }>(
		target,
		"/api/composio/toolkits",
		{},
		fetchComposioToolkitsResponseSchema
	);
	return (json.data ?? []).map((t) => ({
		slug: t.slug ?? "",
		name: t.name ?? t.slug ?? "",
		description: t.description ?? null,
		logo: t.logo ?? null,
	}));
}

export async function fetchComposioActions(
	target: ApiTarget,
	toolkit: string,
	query = "",
	tags: readonly string[] = []
): Promise<ComposioAction[]> {
	const params = new URLSearchParams({ toolkit });
	if (query) {
		params.set("q", query);
	}
	for (const tag of tags) {
		params.append("tags", tag);
	}
	const json = await request<{ data?: ActionWire[] }>(
		target,
		`/api/composio/actions?${params.toString()}`,
		{},
		fetchComposioActionsResponseSchema
	);
	return (json.data ?? []).map((a) => ({
		name: a.name ?? "",
		displayName: a.display_name ?? a.name ?? "",
		description: a.description ?? null,
		toolkit: a.toolkit ?? toolkit,
		noAuth: a.no_auth ?? false,
		tags: Array.isArray(a.tags)
			? a.tags.filter((tag): tag is string => isNativeText(tag))
			: [],
		inputSchema: a.input_schema ?? { type: "object", properties: {} },
	}));
}

export async function fetchComposioTriggers(
	target: ApiTarget,
	toolkit: string
): Promise<ComposioTrigger[]> {
	const json = await request<{ data?: TriggerWire[] }>(
		target,
		`/api/composio/triggers?toolkit=${encodeURIComponent(toolkit)}`,
		{},
		fetchComposioTriggersResponseSchema
	);
	return (json.data ?? []).map((t) => ({
		name: t.name ?? "",
		displayName: t.display_name ?? t.name ?? "",
		description: t.description ?? null,
		toolkit: t.toolkit ?? toolkit,
	}));
}

// ── Connections (proactive connect, Marketplace → Connections tab) ─────────────

/** One of the user's Composio connected accounts. */
export interface ComposioConnection {
	/** Ryu's per-connection action ceiling; unknown values use the safe default. */
	accessLevel: ConnectionAccessLevel;
	/** Whether the connection is active (ready for tool execution). */
	active: boolean;
	/** The connected-account id (poll this after the OAuth redirect). */
	id: string;
	/** Raw Composio status (e.g. ACTIVE, INITIATED, EXPIRED, FAILED). */
	status: string;
	/** Toolkit slug the connection is for. */
	toolkit: string;
}

/** Result of initiating a connection: open `redirectUrl`, then poll `id`. */
export interface ComposioConnectInitiate {
	accessLevel: ConnectionAccessLevel;
	connectionId: string;
	redirectUrl: string;
	status: string;
}

interface ConnectionWire {
	access_level?: unknown;
	active?: boolean;
	id?: string;
	status?: string;
	toolkit?: string;
}

/** List the user's connections, optionally filtered to one toolkit. */
export async function fetchComposioConnections(
	target: ApiTarget,
	toolkit = ""
): Promise<ComposioConnection[]> {
	const path = toolkit
		? `/api/composio/connections?toolkit=${encodeURIComponent(toolkit)}`
		: "/api/composio/connections";
	const json = await request<{ data?: ConnectionWire[] }>(
		target,
		path,
		{},
		fetchComposioConnectionsResponseSchema
	);
	return (json.data ?? []).map((c) => ({
		accessLevel: normalizeConnectionAccessLevel(c.access_level),
		id: c.id ?? "",
		toolkit: c.toolkit ?? toolkit,
		status: c.status ?? "",
		active: c.active ?? false,
	}));
}

/** Start an OAuth connection for a toolkit; returns the redirect URL to open. */
export async function initiateComposioConnection(
	target: ApiTarget,
	toolkit: string,
	accessLevel: ConnectionAccessLevel = DEFAULT_CONNECTION_ACCESS_LEVEL
): Promise<ComposioConnectInitiate> {
	const json = await request<{
		access_level?: unknown;
		connection_id?: string;
		redirect_url?: string;
		status?: string;
	}>(
		target,
		"/api/composio/connections/initiate",
		{
			method: "POST",
			body: { access_level: accessLevel, toolkit },
		},
		initiateComposioConnectionResponseSchema
	);
	return {
		accessLevel: normalizeConnectionAccessLevel(json.access_level),
		connectionId: json.connection_id ?? "",
		redirectUrl: json.redirect_url ?? "",
		status: json.status ?? "INITIATED",
	};
}

/** Poll a single connection's status by id (after the OAuth redirect returns). */
export async function fetchComposioConnectionStatus(
	target: ApiTarget,
	id: string
): Promise<ComposioConnection> {
	const json = await request<ConnectionWire>(
		target,
		`/api/composio/connections/${encodeURIComponent(id)}`,
		{},
		connectionWireResponseSchema
	);
	return {
		accessLevel: normalizeConnectionAccessLevel(json.access_level),
		id: json.id ?? id,
		toolkit: json.toolkit ?? "",
		status: json.status ?? "",
		active: json.active ?? false,
	};
}

const fetchComposioStatusResponseSchema = retainValidatedResponse(
	z.custom<{
		configured?: boolean;
		base_url?: string;
		execution_owner?: string;
	}>(
		(value) =>
			z
				.object({
					configured: z.boolean().optional(),
					base_url: z.string().optional(),
					execution_owner: z.string().optional(),
				})
				.passthrough()
				.safeParse(value).success
	)
);
const fetchComposioToolkitsResponseSchema: z.ZodType<{ data?: ToolkitWire[] }> =
	retainValidatedResponse(
		z
			.object({
				data: z
					.array(
						z
							.object({
								description: z.union([z.string(), z.null()]).optional(),
								logo: z.union([z.string(), z.null()]).optional(),
								name: z.string().optional(),
								slug: z.string().optional(),
							})
							.passthrough()
					)
					.optional(),
			})
			.passthrough()
	);
const fetchComposioActionsResponseSchema: z.ZodType<{ data?: ActionWire[] }> =
	retainValidatedResponse(
		z
			.object({
				data: z
					.array(
						z
							.object({
								description: z.union([z.string(), z.null()]).optional(),
								display_name: z.string().optional(),
								input_schema: z
									.object({
										properties: z
											.record(
												z.string(),
												z
													.object({
														default: gatewayJsonValueSchema.optional(),
														description: z.string().optional(),
														enum: z.array(gatewayJsonValueSchema).optional(),
														title: z.string().optional(),
														type: z
															.union([z.string(), z.array(z.string())])
															.optional(),
													})
													.passthrough()
											)
											.optional(),
										required: z.array(z.string()).optional(),
										type: z.string().optional(),
									})
									.passthrough()
									.optional(),
								name: z.string().optional(),
								no_auth: z.boolean().optional(),
								tags: gatewayJsonValueSchema.optional(),
								toolkit: z.string().optional(),
							})
							.passthrough()
					)
					.optional(),
			})
			.passthrough()
	);
const fetchComposioTriggersResponseSchema: z.ZodType<{ data?: TriggerWire[] }> =
	retainValidatedResponse(
		z
			.object({
				data: z
					.array(
						z
							.object({
								description: z.union([z.string(), z.null()]).optional(),
								display_name: z.string().optional(),
								name: z.string().optional(),
								toolkit: z.string().optional(),
							})
							.passthrough()
					)
					.optional(),
			})
			.passthrough()
	);
const fetchComposioConnectionsResponseSchema: z.ZodType<{
	data?: ConnectionWire[];
}> = retainValidatedResponse(
	z
		.object({
			data: z
				.array(
					z
						.object({
							access_level: gatewayJsonValueSchema.optional(),
							active: z.boolean().optional(),
							id: z.string().optional(),
							status: z.string().optional(),
							toolkit: z.string().optional(),
						})
						.passthrough()
				)
				.optional(),
		})
		.passthrough()
);
const initiateComposioConnectionResponseSchema = retainValidatedResponse(
	z.custom<{
		access_level?: unknown;
		connection_id?: string;
		redirect_url?: string;
		status?: string;
	}>(
		(value) =>
			z
				.object({
					access_level: gatewayJsonValueSchema.optional(),
					connection_id: z.string().optional(),
					redirect_url: z.string().optional(),
					status: z.string().optional(),
				})
				.passthrough()
				.safeParse(value).success
	)
);
const connectionWireResponseSchema: z.ZodType<ConnectionWire> =
	retainValidatedResponse(
		z
			.object({
				access_level: gatewayJsonValueSchema.optional(),
				active: z.boolean().optional(),
				id: z.string().optional(),
				status: z.string().optional(),
				toolkit: z.string().optional(),
			})
			.passthrough()
	);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}

// ── An agent's own Composio accounts ────────────────────────────────────────
//
// Apps connected to the agent's own Composio identity (`individual` and `mixed`
// agents), never to the user's. Core keeps these routes operator-only, so an
// agent cannot reach them through its own API. Each account's allowlist key is
// `agent-composio:<id>`.

/**
 * Core's error code when the node runs Composio through a Connect service
 * whose tenant does not enable agent accounts.
 */
export const AGENT_COMPOSIO_UNSUPPORTED_CODE = "agent_entity_unsupported";

/** Whether Core refused an agent's own Composio route for its Connect service. */
export function isAgentComposioUnsupported(error: unknown): boolean {
	if (!(error instanceof ApiError)) {
		return false;
	}
	if (error.code === AGENT_COMPOSIO_UNSUPPORTED_CODE) {
		return true;
	}
	const body = z
		.object({ code: z.string().optional() })
		.passthrough()
		.safeParse(error.body);
	return body.success && body.data.code === AGENT_COMPOSIO_UNSUPPORTED_CODE;
}

/** One app connected to an agent's own Composio identity. */
export interface AgentComposioConnection extends ComposioConnection {
	/** Its allowlist key, `agent-composio:<id>`. */
	key: string;
}

export interface AgentComposioConnections {
	/** `false` when no Composio key is set on the node. */
	configured: boolean;
	connections: AgentComposioConnection[];
}

function agentComposioPath(agentId: string, rest = ""): string {
	return `/api/agents/${encodeURIComponent(agentId)}/composio/connections${rest}`;
}

function agentConnectionFromWire(
	wire: ConnectionWire & { key?: string },
	fallbackId = ""
): AgentComposioConnection {
	const id = wire.id ?? fallbackId;
	return {
		accessLevel: normalizeConnectionAccessLevel(wire.access_level),
		active: wire.active ?? false,
		id,
		key: wire.key ?? `agent-composio:${id}`,
		status: wire.status ?? "",
		toolkit: wire.toolkit ?? "",
	};
}

const agentConnectionWireSchema = z
	.object({
		access_level: gatewayJsonValueSchema.optional(),
		active: z.boolean().optional(),
		id: z.string().optional(),
		key: z.string().optional(),
		status: z.string().optional(),
		toolkit: z.string().optional(),
	})
	.passthrough();
const agentComposioConnectionsResponseSchema = retainValidatedResponse(
	z
		.object({
			configured: z.boolean().optional(),
			data: z.array(agentConnectionWireSchema).optional(),
		})
		.passthrough()
);
const agentComposioConnectionResponseSchema = retainValidatedResponse(
	agentConnectionWireSchema
);
const disconnectAgentComposioResponseSchema = retainValidatedResponse(
	z.object({ ok: z.boolean().optional() }).passthrough()
);

/** List the apps connected to an agent's own identity. */
export async function fetchAgentComposioConnections(
	target: ApiTarget,
	agentId: string,
	toolkit = ""
): Promise<AgentComposioConnections> {
	const query = toolkit ? `?toolkit=${encodeURIComponent(toolkit)}` : "";
	const json = await request(
		target,
		agentComposioPath(agentId, query),
		{},
		agentComposioConnectionsResponseSchema
	);
	return {
		configured: json.configured ?? true,
		connections: (json.data ?? []).map((wire) => agentConnectionFromWire(wire)),
	};
}

/** Start connecting an app to an agent's own identity; open `redirectUrl`. */
export async function initiateAgentComposioConnection(
	target: ApiTarget,
	agentId: string,
	toolkit: string,
	accessLevel: ConnectionAccessLevel = DEFAULT_CONNECTION_ACCESS_LEVEL
): Promise<ComposioConnectInitiate> {
	const json = await request(
		target,
		agentComposioPath(agentId, "/initiate"),
		{
			method: "POST",
			body: { access_level: accessLevel, toolkit },
		},
		initiateComposioConnectionResponseSchema
	);
	return {
		accessLevel: normalizeConnectionAccessLevel(json.access_level),
		connectionId: json.connection_id ?? "",
		redirectUrl: json.redirect_url ?? "",
		status: json.status ?? "INITIATED",
	};
}

/** Read one app connected to an agent's own identity (404 if it is not). */
export async function fetchAgentComposioConnectionStatus(
	target: ApiTarget,
	agentId: string,
	id: string
): Promise<AgentComposioConnection> {
	const json = await request(
		target,
		agentComposioPath(agentId, `/${encodeURIComponent(id)}`),
		{},
		agentComposioConnectionResponseSchema
	);
	return agentConnectionFromWire(json, id);
}

/** Disconnect an app from an agent's own identity. */
export async function disconnectAgentComposioConnection(
	target: ApiTarget,
	agentId: string,
	id: string
): Promise<void> {
	await request(
		target,
		agentComposioPath(agentId, `/${encodeURIComponent(id)}`),
		{ method: "DELETE" },
		disconnectAgentComposioResponseSchema
	);
}
