// apps/desktop/src/lib/api/node-timezone.ts
//
// A managed node's quiet-hour time zone, read and written on the CONTROL PLANE.
//
// Unlike `lib/api/update.ts` — which talks to a node's own Core — this targets
// the identity/control-plane server (BACKEND_URL) with the Better-Auth session
// bearer, the same idiom as `org.ts` / `managed-nodes.ts`. "Which zone this
// node's night is in" is a registry fact about a server row the control plane
// owns, not something the node itself stores.
//
// WHY THE ZONE IS PER NODE AND NOT PER ORG: an org running one node in
// Frankfurt and another in Singapore has two different nights. A single
// org-level zone would schedule a restart into one of the two working days
// every time.
//
// THE ROUTE NEEDS TWO IDS THE DESKTOP USED TO THROW AWAY. `orgId` and
// `serverId` are carried on `Node` (see `useNodeStore.ts`), because `serverId`
// is a `ProvisionedServer._id` — a different id space from the
// `GatewayCredential._id` the node list calls `id`, and not derivable from it.
// Adopted and resumed nodes have no server row at all; `serverId` is null for
// them and the surface must hide itself rather than guess a row by URL, which
// would write one node's settings onto another's.

import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import { pluginRecord, pluginValueSchema } from "./plugin-wire-values.ts";

/** GET returns serializeServer; PATCH returns the separate timezone publisher.
 * Known fields mirror packages/api/src/routers/servers.ts and retain legacy
 * optional lifecycle fields plus full future JSON metadata without cloning. */
function preservePublisher<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginValueSchema.safeParse(value).success &&
			schema.safeParse(value).success
	);
}
const nullableText = z.string().nullable();
export const nodeTimeZonePatchSchema = preservePublisher(
	z
		.looseObject({
			id: z.string(),
			detectedTimeZone: nullableText,
			effectiveTimeZone: z.string(),
			nextQuietWindow: z.string(),
			timeZone: nullableText,
		})
		.catchall(pluginValueSchema)
);
export const nodeTimeZoneServerSchema = preservePublisher(
	z
		.looseObject({
			archived: z.boolean().optional(),
			backupsEnabled: z.boolean(),
			createdAt: z.string(),
			createdBy: z.string(),
			desktopEnabled: z.boolean(),
			detectedTimeZone: nullableText,
			effectiveTimeZone: z.string(),
			error: nullableText,
			hetznerServerId: nullableText,
			hetznerType: z.string(),
			id: z.string(),
			includedWithMax: z.boolean(),
			includedWithPlan: z.boolean(),
			inferenceMode: z.enum(["managed", "byok"]),
			location: z.string(),
			monthlyUsdSnapshot: z.number(),
			organizationId: z.string(),
			polarSubscriptionId: nullableText,
			publicUrl: nullableText,
			removalReason: nullableText.optional(),
			removeGraceEndsAt: nullableText,
			removeScheduledAt: nullableText,
			runsUntil: nullableText.optional(),
			sshSetupRequired: z.boolean().optional(),
			status: z.enum([
				"provisioning",
				"active",
				"removing",
				"removed",
				"error",
			]),
			timeZone: nullableText,
			updatedAt: z.string(),
		})
		.catchall(pluginValueSchema)
);

/** What both endpoints below answer with. */
export interface NodeTimeZone {
	/** What the node reported from its own clock. Null until it has handshaked. */
	detectedTimeZone: string | null;
	/**
	 * The zone the quiet hour is ACTUALLY measured in, after precedence
	 * (`timeZone` → `detectedTimeZone` → `UTC`). This is what a surface should
	 * show: the override is null on a correctly-configured node, so rendering it
	 * directly would render a blank.
	 */
	effectiveTimeZone: string;
	/** The explicit human choice, or null when the node's own report is used. */
	timeZone: string | null;
}

/** Carries the server's own message, so a 403 explains it needs an admin. */
export class NodeTimeZoneError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "NodeTimeZoneError";
		this.status = status;
	}
}

function serversBase(): string {
	return `${BACKEND_URL.replace(/\/$/, "")}/api/servers`;
}

function authToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

async function request<S extends z.ZodType>(
	path: string,
	schema: S,
	init?: RequestInit
): Promise<z.output<S>> {
	const token = authToken();
	if (!token) {
		throw new NodeTimeZoneError(401, "Sign in to manage this node.");
	}
	const headers = new Headers({ Authorization: `Bearer ${token}` });
	if (init?.body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const resp = await fetch(`${serversBase()}${path}`, {
		...init,
		headers,
	});
	if (!resp.ok) {
		// The server's own sentence is far more useful than a status code here:
		// "requires admin role" and "not a recognised IANA time zone" are both
		// things the person looking at the row can act on.
		const body = pluginRecord(await resp.json().catch(() => null));
		throw new NodeTimeZoneError(
			resp.status,
			String(body?.message ?? `Request failed: ${resp.status}`)
		);
	}
	return schema.parse(await resp.json());
}

/**
 * Read a managed node's zone. Member-readable — knowing when the node restarts
 * is exactly what everyone whose agents run on it needs to see, not just the
 * admin who can change it.
 */
export function getNodeTimeZone(
	orgId: string,
	serverId: string
): Promise<NodeTimeZone> {
	return request(
		`/orgs/${orgId}/servers/${serverId}`,
		nodeTimeZoneServerSchema
	);
}

/**
 * Set (or clear) the override. Requires org admin; a member gets a 403 whose
 * message says so.
 *
 * Passing `null` CLEARS the override and returns the node to whatever it reports
 * for itself, which is the sane default — a machine in Frankfurt already knows
 * it is in Frankfurt. Clearing is a first-class action rather than something you
 * approximate by picking the zone you believe the node is in.
 */
export function setNodeTimeZone(
	orgId: string,
	serverId: string,
	timeZone: string | null
): Promise<NodeTimeZone> {
	return request(
		`/orgs/${orgId}/servers/${serverId}/timezone`,
		nodeTimeZonePatchSchema,
		{
			method: "PATCH",
			body: JSON.stringify({ timeZone }),
		}
	);
}

/**
 * The zone list offered by the picker.
 *
 * `Intl.supportedValuesOf` is the full IANA set the runtime already ships;
 * the short list is a fallback for a runtime that does not expose it, chosen to
 * cover the regions nodes are actually provisioned in rather than to be
 * complete — a partial list beats an empty picker.
 */
export const NODE_TIME_ZONES: string[] = (() => {
	try {
		const values = Intl.supportedValuesOf?.("timeZone");
		if (values && values.length > 0) {
			return [...values];
		}
	} catch {
		// Older runtime — fall through to the short list.
	}
	return [
		"UTC",
		"America/Los_Angeles",
		"America/New_York",
		"Europe/London",
		"Europe/Berlin",
		"Asia/Singapore",
		"Asia/Tokyo",
		"Australia/Sydney",
	];
})();
