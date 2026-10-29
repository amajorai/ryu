// apps/desktop/src/lib/api/local-egress.ts
//
// "Route traffic through this computer": this desktop's Core becomes the network
// exit for the user's own cloud nodes, so sites see this computer's IP address.
//
// The setting lives on the LOCAL Core (never the active node), which dials out to
// each node itself. Node credentials are short-lived delegations that Core keeps
// only in memory, so the app re-supplies them whenever it refreshes managed
// nodes (the node store does this on its token-refresh cadence).
//
//   GET /api/local-egress/desktop  -> { enabled, nodes: [{ nodeId, state, … }] }
//   PUT /api/local-egress/desktop  <- { enabled, deviceName?, nodes }

import { z } from "zod";
import { getActiveUserId } from "@/lib/auth-client.ts";
import { type ApiTarget, request } from "./client.ts";
import type { ManagedNode } from "./managed-nodes.ts";

export type DesktopRouteLinkState =
	| { state: "connecting" }
	| { connectedSinceMs: number; state: "connected" }
	| { error: string; state: "offline" }
	| { state: "disabled_by_admin" }
	| { state: "unauthorized" };

export type DesktopRouteLink = DesktopRouteLinkState & { nodeId: string };

export interface DesktopRouteStatus {
	enabled: boolean;
	nodes: DesktopRouteLink[];
}

export interface DesktopRouteNode {
	nodeId: string;
	token: string;
	url: string;
}

// Core's `exit::ExitStatus`: `LinkState` is flattened into each node row and
// tagged by `state`.
const desktopRouteLinkSchema = z.discriminatedUnion("state", [
	z.object({ nodeId: z.string(), state: z.literal("connecting") }),
	z.object({
		connectedSinceMs: z.number(),
		nodeId: z.string(),
		state: z.literal("connected"),
	}),
	z.object({
		error: z.string(),
		nodeId: z.string(),
		state: z.literal("offline"),
	}),
	z.object({ nodeId: z.string(), state: z.literal("disabled_by_admin") }),
	z.object({ nodeId: z.string(), state: z.literal("unauthorized") }),
]) satisfies z.ZodType<DesktopRouteLink>;

const desktopRouteStatusSchema = z.object({
	enabled: z.boolean(),
	nodes: z.array(desktopRouteLinkSchema),
}) satisfies z.ZodType<DesktopRouteStatus>;

const ROUTE_PATH = "/api/local-egress/desktop";

export function fetchDesktopRoute(
	target: ApiTarget
): Promise<DesktopRouteStatus> {
	return request(target, ROUTE_PATH, undefined, desktopRouteStatusSchema);
}

export function configureDesktopRoute(
	target: ApiTarget,
	body: { deviceName?: string; enabled: boolean; nodes: DesktopRouteNode[] }
): Promise<DesktopRouteStatus> {
	return request(
		target,
		ROUTE_PATH,
		{ method: "PUT", body },
		desktopRouteStatusSchema
	);
}

/**
 * The nodes this computer may route: managed nodes the signed-in user owns
 * personally, with a reachable URL and a fresh node credential. Shared org and
 * team nodes are excluded, so one member's desktop never carries the traffic
 * of a node other members also use.
 */
export function routableNodes(
	managed: readonly ManagedNode[],
	userId: string | null
): DesktopRouteNode[] {
	if (!userId) {
		return [];
	}
	return managed.flatMap((node) =>
		node.ownerUserId === userId && node.url?.trim() && node.userJwt?.trim()
			? [{ nodeId: node.id, token: node.userJwt, url: node.url }]
			: []
	);
}

/** A readable name for this computer, shown on the cloud node while attached. */
export function desktopDeviceName(): string {
	if (typeof navigator === "undefined") {
		return "Desktop";
	}
	const platform = navigator.userAgent.includes("Mac")
		? "Mac"
		: navigator.userAgent.includes("Windows")
			? "Windows PC"
			: "Linux computer";
	return `${platform} desktop`;
}

/**
 * Re-supply fresh node credentials to the local Core while the setting is on.
 * Best-effort and silent: a missing local Core or an offline control plane
 * leaves the existing routes running until the next refresh.
 */
export async function syncDesktopRoute(
	local: ApiTarget,
	managed: readonly ManagedNode[]
): Promise<void> {
	try {
		const current = await fetchDesktopRoute(local);
		if (!current.enabled) {
			return;
		}
		await configureDesktopRoute(local, {
			enabled: true,
			deviceName: desktopDeviceName(),
			nodes: routableNodes(managed, getActiveUserId()),
		});
	} catch {
		// Older Core without the route, or Core restarting: retry next refresh.
	}
}

// ── Provider routes (on the cloud node) ──────────────────────────────────────
//
// A cloud node can also send one model provider's traffic through the routing
// desktop, for providers that refuse data-center addresses (Claude subscription
// logins). Unlike the desktop setting above, this lives on the NODE, so it is
// read and written through the active node target.
//
//   GET /api/local-egress/route/providers -> { route, providers: [{ id, enabled }] }
//   PUT /api/local-egress/route/providers <- { id, enabled }

export type ProviderRouteId = "claude";

export interface NodeRouteStatus {
	/** The org allows routing through a desktop. */
	allowed: boolean;
	connected: boolean;
	desktop: string | null;
	/** A desktop asked to route this node and has not turned it off. */
	routed: boolean;
	supported: boolean;
}

export interface ProviderRoutesStatus {
	providers: { enabled: boolean; id: string }[];
	route: NodeRouteStatus;
}

const providerRoutesStatusSchema = z.object({
	providers: z.array(z.object({ enabled: z.boolean(), id: z.string() })),
	route: z.object({
		allowed: z.boolean(),
		connected: z.boolean(),
		desktop: z.string().nullable(),
		routed: z.boolean(),
		supported: z.boolean(),
	}),
}) satisfies z.ZodType<ProviderRoutesStatus>;

const PROVIDER_ROUTES_PATH = "/api/local-egress/route/providers";

export function fetchProviderRoutes(
	target: ApiTarget
): Promise<ProviderRoutesStatus> {
	return request(
		target,
		PROVIDER_ROUTES_PATH,
		undefined,
		providerRoutesStatusSchema
	);
}

export function configureProviderRoute(
	target: ApiTarget,
	body: { enabled: boolean; id: ProviderRouteId }
): Promise<ProviderRoutesStatus> {
	return request(
		target,
		PROVIDER_ROUTES_PATH,
		{ method: "PUT", body },
		providerRoutesStatusSchema
	);
}
