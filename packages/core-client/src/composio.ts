// apps/desktop/src/lib/api/composio.ts
//
// Typed client for Core's Composio browse catalog (`/api/composio/*`). Core uses
// Connect's tenant-scoped service in remote mode, with embedded compatibility
// otherwise. These descriptors feed the agent editor's Tools/Triggers pickers.

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";

const composioConfigSchema = z.custom<Record<string, AppResponseValue>>(
	(value) =>
		z.record(z.string(), appResponseValueSchema).safeParse(value).success
);
const completionSchema = z.object({
	id: z.string().min(1),
	toolkit: z.string(),
	status: z.literal("ACTIVE"),
	active: z.literal(true),
});

import { type ApiTarget, request } from "./client.ts";

// Complete controlled catalog/status/connection publisher footprints. Older
// optional fields retain the original normalizers; native metadata stays raw.
const statusResponseFields = z.object({
	configured: z.boolean().optional(),
	base_url: z.string().optional(),
	execution_owner: z.string().optional(),
});
const toolkitFields = z.object({
	description: z.string().nullable().optional(),
	logo: z.string().nullable().optional(),
	name: z.string().optional(),
	slug: z.string().optional(),
	categories: appResponseValueSchema.optional(),
});
const actionFields = z.object({
	description: z.string().nullable().optional(),
	display_name: z.string().optional(),
	name: z.string().optional(),
	no_auth: z.boolean().optional(),
	toolkit: z.string().optional(),
	tags: appResponseValueSchema.optional(),
	input_schema: appResponseValueSchema.optional(),
	version: z.string().optional(),
});
const triggerFields = z.object({
	config: appResponseValueSchema.optional(),
	description: z.string().nullable().optional(),
	display_name: z.string().optional(),
	name: z.string().optional(),
	toolkit: z.string().optional(),
});
const connectionFields = z.object({
	access_level: appResponseValueSchema.optional(),
	active: z.boolean().optional(),
	id: z.string().optional(),
	status: z.string().optional(),
	toolkit: z.string().optional(),
});
const toolkitsResponseFields = z.object({
	object: z.string().optional(),
	data: z.array(toolkitFields).optional(),
	error: z.string().optional(),
});
const actionsResponseFields = z.object({
	object: z.string().optional(),
	toolkit: z.string().optional(),
	data: z.array(actionFields).optional(),
	error: z.string().optional(),
});
const triggersResponseFields = z.object({
	object: z.string().optional(),
	toolkit: z.string().optional(),
	data: z.array(triggerFields).optional(),
	error: z.string().optional(),
});
const connectionsResponseFields = z.object({
	object: z.string().optional(),
	configured: z.boolean().optional(),
	data: z.array(connectionFields).optional(),
	error: z.string().optional(),
});
const statusResponseSchema = z.custom<z.output<typeof statusResponseFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		statusResponseFields.safeParse(value).success
);
const toolkitsResponseSchema = z.custom<
	z.output<typeof toolkitsResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		toolkitsResponseFields.safeParse(value).success
);
const actionsResponseSchema = z.custom<z.output<typeof actionsResponseFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		actionsResponseFields.safeParse(value).success
);
const triggersResponseSchema = z.custom<
	z.output<typeof triggersResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		triggersResponseFields.safeParse(value).success
);
const connectionsResponseSchema = z.custom<
	z.output<typeof connectionsResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		connectionsResponseFields.safeParse(value).success
);

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
	name: string;
	noAuth: boolean;
	toolkit: string;
}

/** A Composio trigger type (an event a toolkit can fire). */
export interface ComposioTrigger {
	config?: Record<string, AppResponseValue> | null;
	description: string | null;
	displayName: string;
	name: string;
	toolkit: string;
}

export async function fetchComposioStatus(
	target: ApiTarget
): Promise<ComposioStatus> {
	const json = await request(
		target,
		"/api/composio/status",
		undefined,
		statusResponseSchema
	);
	const status: ComposioStatus = {
		configured: json.configured ?? false,
		baseUrl: json.base_url ?? "",
	};
	if (json.execution_owner === "connect") {
		status.executionOwner = "connect";
	}
	return status;
}

export async function fetchComposioToolkits(
	target: ApiTarget
): Promise<ComposioToolkit[]> {
	const json = await request(
		target,
		"/api/composio/toolkits",
		undefined,
		toolkitsResponseSchema
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
	const json = await request(
		target,
		`/api/composio/actions?${params.toString()}`,
		undefined,
		actionsResponseSchema
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
	const json = await request(
		target,
		`/api/composio/triggers?toolkit=${encodeURIComponent(toolkit)}`,
		undefined,
		triggersResponseSchema
	);
	return (json.data ?? []).map((t) => {
		const config = composioConfigSchema.safeParse(t.config);
		return {
			config: config.success ? config.data : null,
			name: t.name ?? "",
			displayName: t.display_name ?? t.name ?? "",
			description: t.description ?? null,
			toolkit: t.toolkit ?? toolkit,
		};
	});
}

/** One of the user's Composio connected accounts. */
export type ConnectionAccessLevel =
	| "risk_based"
	| "read_only"
	| "write"
	| "full";

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

type ConnectionWire = z.output<typeof connectionFields>;

/** List the user's connections, optionally filtered to one toolkit. */
export async function fetchComposioConnections(
	target: ApiTarget,
	toolkit = ""
): Promise<ComposioConnection[]> {
	const path = toolkit
		? `/api/composio/connections?toolkit=${encodeURIComponent(toolkit)}`
		: "/api/composio/connections";
	const json = await request(
		target,
		path,
		undefined,
		connectionsResponseSchema
	);
	return (json.data ?? []).map((c) => ({
		accessLevel: normalizeAccessLevel(c.access_level),
		id: c.id ?? "",
		toolkit: c.toolkit ?? toolkit,
		status: c.status ?? "",
		active: c.active ?? false,
	}));
}

function normalizeAccessLevel(
	value: ConnectionWire["access_level"]
): ConnectionAccessLevel {
	if (
		value === "risk_based" ||
		value === "read_only" ||
		value === "write" ||
		value === "full"
	) {
		return value;
	}
	return "risk_based";
}

/** Completion metadata only; refresh the connection list for its access policy. */
export interface ComposioConnectionCompletion {
	active: true;
	id: string;
	status: "ACTIVE";
	toolkit: string;
}

export async function completeComposioConnection(
	target: ApiTarget,
	sessionUri: string,
	send: typeof request = request
): Promise<ComposioConnectionCompletion> {
	if (!sessionUri || new TextEncoder().encode(sessionUri).byteLength > 4096) {
		throw new Error("Invalid callback session URI");
	}
	const completion = completionSchema.safeParse(
		await send(
			target,
			"/api/composio/connections/complete",
			{
				method: "POST",
				body: { sessionUri },
				signal: AbortSignal.timeout(45_000),
			},
			appResponseValueSchema
		)
	);
	if (!completion.success) {
		throw new Error("Core did not confirm an active connection");
	}
	return {
		id: completion.data.id,
		toolkit: completion.data.toolkit,
		status: "ACTIVE",
		active: true,
	};
}
