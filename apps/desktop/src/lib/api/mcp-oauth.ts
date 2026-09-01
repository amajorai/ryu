// Typed, metadata-only client for Core-owned remote MCP OAuth.

import {
	type ConnectionAccessLevel,
	DEFAULT_CONNECTION_ACCESS_LEVEL,
	normalizeConnectionAccessLevel,
} from "../connection-permissions.ts";
import { type ApiTarget, request } from "./client.ts";

export type McpOAuthStatus = "connected" | "reauth_required";

export interface McpOAuthConnection {
	accessLevel: ConnectionAccessLevel;
	accountLabel: string | null;
	expiresAt: number | null;
	id: string;
	issuer: string;
	profileId: string;
	resource: string;
	scopes: string[];
	status: McpOAuthStatus;
}

export interface McpOAuthServerStatus {
	clientId: string | null;
	connections: McpOAuthConnection[];
	resource: string;
	serverName: string;
}

interface ConnectionWire {
	access_level?: unknown;
	account_label?: string | null;
	expires_at?: number | null;
	id: string;
	issuer: string;
	profile_id: string;
	resource_uri: string;
	scopes?: string[];
	status: McpOAuthStatus;
}

interface ServerWire {
	client_id?: string | null;
	connections?: ConnectionWire[];
	resource?: string | null;
	server_name: string;
}

export interface McpOAuthConnectStarted {
	accessLevel: ConnectionAccessLevel;
	authorizationUrl: string;
	callbackMode: "loopback" | "hosted";
	expiresAt: number;
	flowId: string;
	scopes: string[];
	status: "pending";
}

export interface McpOAuthFlow {
	accessLevel: ConnectionAccessLevel;
	callbackMode: "loopback" | "hosted";
	error: string | null;
	expiresAt: number;
	flowId: string;
	pluginId: string;
	profileId: string;
	scopes: string[];
	serverName: string;
	status: "pending" | "connected" | "failed";
}

const mapConnection = (wire: ConnectionWire): McpOAuthConnection => ({
	accessLevel: normalizeConnectionAccessLevel(wire.access_level),
	accountLabel: wire.account_label ?? null,
	expiresAt: wire.expires_at ?? null,
	id: wire.id,
	issuer: wire.issuer,
	profileId: wire.profile_id,
	resource: wire.resource_uri,
	scopes: wire.scopes ?? [],
	status: wire.status,
});

export async function fetchMcpOAuth(
	target: ApiTarget,
	pluginId: string
): Promise<McpOAuthServerStatus[]> {
	const response = await request<{ servers?: ServerWire[] }>(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/auth`
	);
	return (response.servers ?? []).map((server) => ({
		clientId: server.client_id ?? null,
		connections: (server.connections ?? []).map(mapConnection),
		resource: server.resource ?? "",
		serverName: server.server_name,
	}));
}

export async function connectMcpOAuth(
	target: ApiTarget,
	pluginId: string,
	serverName: string,
	profileId: string,
	accessLevel: ConnectionAccessLevel = DEFAULT_CONNECTION_ACCESS_LEVEL
): Promise<McpOAuthConnectStarted> {
	const response = await request<{
		access_level?: unknown;
		authorization_url: string;
		callback_mode: "loopback" | "hosted";
		expires_at: number;
		flow_id: string;
		scopes?: string[];
		status: "pending";
	}>(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/auth/${encodeURIComponent(serverName)}/connect`,
		{
			body: {
				access_level: accessLevel,
				callback_mode: "auto",
				profile_id: profileId,
			},
			method: "POST",
		}
	);
	return {
		accessLevel: normalizeConnectionAccessLevel(response.access_level),
		authorizationUrl: response.authorization_url,
		callbackMode: response.callback_mode,
		expiresAt: response.expires_at,
		flowId: response.flow_id,
		scopes: response.scopes ?? [],
		status: response.status,
	};
}

export async function disconnectMcpOAuth(
	target: ApiTarget,
	pluginId: string,
	serverName: string,
	profileId: string
): Promise<{ deleted: boolean; revocation: "confirmed" | "not_confirmed" }> {
	return request(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/auth/${encodeURIComponent(serverName)}?profile_id=${encodeURIComponent(profileId)}`,
		{ method: "DELETE" }
	);
}

export async function fetchMcpOAuthFlow(
	target: ApiTarget,
	pluginId: string,
	flowId: string
): Promise<McpOAuthFlow> {
	const response = await request<{
		access_level?: unknown;
		callback_mode: "loopback" | "hosted";
		error?: string | null;
		expires_at: number;
		flow_id: string;
		plugin_id: string;
		profile_id: string;
		scopes?: string[];
		server_name: string;
		status: "pending" | "connected" | "failed";
	}>(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/auth/flows/${encodeURIComponent(flowId)}`
	);
	return {
		accessLevel: normalizeConnectionAccessLevel(response.access_level),
		callbackMode: response.callback_mode,
		error: response.error ?? null,
		expiresAt: response.expires_at,
		flowId: response.flow_id,
		pluginId: response.plugin_id,
		profileId: response.profile_id,
		scopes: response.scopes ?? [],
		serverName: response.server_name,
		status: response.status,
	};
}
