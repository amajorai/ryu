// apps/desktop/src/lib/api/composio.ts
//
// Typed client for Core's Composio browse catalog (`/api/composio/*`). Core uses
// the user's configured Composio key (Settings → Integrations) to list their
// available toolkits, actions, and trigger types. Execution itself happens in
// the gateway; this client only browses descriptors for the agent editor's
// Tools/Triggers pickers.

import { type ApiTarget, request } from "./client.ts";

/** Whether a Composio key is configured + the active REST base. */
export interface ComposioStatus {
	baseUrl: string;
	configured: boolean;
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
	name: string;
	noAuth: boolean;
	toolkit: string;
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
	name?: string;
	no_auth?: boolean;
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
	const json = await request<{ configured?: boolean; base_url?: string }>(
		target,
		"/api/composio/status"
	);
	return {
		configured: json.configured ?? false,
		baseUrl: json.base_url ?? "",
	};
}

export async function fetchComposioToolkits(
	target: ApiTarget
): Promise<ComposioToolkit[]> {
	const json = await request<{ data?: ToolkitWire[] }>(
		target,
		"/api/composio/toolkits"
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
	query = ""
): Promise<ComposioAction[]> {
	const params = new URLSearchParams({ toolkit });
	if (query) {
		params.set("q", query);
	}
	const json = await request<{ data?: ActionWire[] }>(
		target,
		`/api/composio/actions?${params.toString()}`
	);
	return (json.data ?? []).map((a) => ({
		name: a.name ?? "",
		displayName: a.display_name ?? a.name ?? "",
		description: a.description ?? null,
		toolkit: a.toolkit ?? toolkit,
		noAuth: a.no_auth ?? false,
	}));
}

export async function fetchComposioTriggers(
	target: ApiTarget,
	toolkit: string
): Promise<ComposioTrigger[]> {
	const json = await request<{ data?: TriggerWire[] }>(
		target,
		`/api/composio/triggers?toolkit=${encodeURIComponent(toolkit)}`
	);
	return (json.data ?? []).map((t) => ({
		name: t.name ?? "",
		displayName: t.display_name ?? t.name ?? "",
		description: t.description ?? null,
		toolkit: t.toolkit ?? toolkit,
	}));
}

/** One of the user's Composio connected accounts. */
export interface ComposioConnection {
	/** Whether the connection is active (ready for tool execution). */
	active: boolean;
	/** The connected-account id (poll this after the OAuth redirect). */
	id: string;
	/** Raw Composio status (e.g. ACTIVE, INITIATED, EXPIRED, FAILED). */
	status: string;
	/** Toolkit slug the connection is for. */
	toolkit: string;
}

interface ConnectionWire {
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
	const json = await request<{ data?: ConnectionWire[] }>(target, path);
	return (json.data ?? []).map((c) => ({
		id: c.id ?? "",
		toolkit: c.toolkit ?? toolkit,
		status: c.status ?? "",
		active: c.active ?? false,
	}));
}
