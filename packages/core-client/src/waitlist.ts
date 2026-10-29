import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";
import { openSse, type SseMessage } from "@ryuhq/protocol/sse";
import {
	type WaitlistMe,
	type WaitlistStatusEvent,
	waitlistStatusEventSchema,
} from "@ryuhq/protocol/waitlist";
import { z } from "zod";
import { fetchForTarget, type RyuFetch } from "./client.ts";

export type WaitlistAccess =
	| "approved"
	| "pending"
	| "unauthenticated"
	| "unavailable";

export type NodeWaitlistAccess =
	| { scope: "bypassed" }
	| { access: WaitlistAccess; scope: "all" | "managed" };

export type {
	WaitlistMe,
	WaitlistStatus,
	WaitlistStatusEvent,
} from "@ryuhq/protocol/waitlist";

export interface WaitlistClientTarget {
	fetch?: RyuFetch;
	token?: string | null;
	url: string;
}

const nullableStringSchema = z.string().nullable().catch(null);
const positiveIntegerSchema = z
	.number()
	.int()
	.positive()
	.nullable()
	.catch(null);
const nonNegativeIntegerSchema = z
	.number()
	.finite()
	.nonnegative()
	.transform(Math.floor)
	.catch(0);

const waitlistMeSchema = z
	.object({
		status: z.enum(["pending", "approved"]),
		applicationStatus: z
			.enum(["submitted", "approved", "rejected"])
			.nullable()
			.catch(null),
		displayUsername: nullableStringSchema,
		eta: nullableStringSchema,
		hasApplied: z.boolean().catch(false),
		isAdmin: z.boolean().catch(false),
		joinedAt: nullableStringSchema,
		position: positiveIntegerSchema,
		referralCode: nullableStringSchema,
		referralCount: nonNegativeIntegerSchema,
		referralUrl: nullableStringSchema,
		totalWaiting: nonNegativeIntegerSchema,
		username: nullableStringSchema,
	})
	.nullable()
	.catch(null);

/** Parse the control-plane response at the network boundary. */
export const parseWaitlistMe = waitlistMeSchema.parse;

const featuresSchema = z
	.object({
		[WAITLIST_MANAGED_ONLY_FLAG.key]: z
			.boolean()
			.catch(WAITLIST_MANAGED_ONLY_FLAG.defaultValue),
	})
	.catch(() => ({
		[WAITLIST_MANAGED_ONLY_FLAG.key]: WAITLIST_MANAGED_ONLY_FLAG.defaultValue,
	}))
	.transform((features) => features[WAITLIST_MANAGED_ONLY_FLAG.key]);

/** Shared defaults keep unknown servers on all-node gating. */
export const waitlistManagedOnlyFromFeatures = featuresSchema.parse;

function baseUrl(target: WaitlistClientTarget): string {
	return target.url.replace(/\/+$/, "");
}

function requestHeaders(target: WaitlistClientTarget): Record<string, string> {
	const token = target.token?.trim();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

const nodeUrlSchema = z.string().transform((value, context) => {
	try {
		const url = new URL(value.trim());
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password
		) {
			context.addIssue({ code: "custom", message: "Invalid managed node URL" });
			return z.NEVER;
		}
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		context.addIssue({ code: "custom", message: "Invalid managed node URL" });
		return z.NEVER;
	}
});
const normalizedNodeUrl = nodeUrlSchema.nullable().catch(null).parse;
const managedNodeUrlsFrom = z
	.object({ nodes: z.array(z.object({ url: nodeUrlSchema })) })
	.transform((payload) => payload.nodes.map((node) => node.url))
	.nullable()
	.catch(null).parse;
const featureResponseSchema = z
	.object({ features: featuresSchema })
	.catch(() => ({ features: WAITLIST_MANAGED_ONLY_FLAG.defaultValue }));

/** Fetch the authenticated user's reachable managed-node URLs.
 *
 * `null` means the control plane could not authoritatively classify the nodes;
 * callers then keep the waitlist scoped to nodes explicitly returned by it.
 */
export async function fetchManagedNodeUrls(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): Promise<string[] | null> {
	const token = target.token?.trim();
	if (!token) {
		return null;
	}
	try {
		const response = await fetchForTarget(target)(
			`${baseUrl(target)}/api/control-plane/nodes`,
			{
				cache: "no-store",
				credentials: "include",
				headers: { Authorization: `Bearer ${token}` },
				signal,
			}
		);
		if (!response.ok) {
			return null;
		}
		return managedNodeUrlsFrom(await response.json());
	} catch {
		return null;
	}
}

/**
 * Read the server-controlled waitlist scope, or `null` when it could not be
 * read (non-2xx, network failure, abort, or a body that is not JSON). A JSON
 * body without the flag is a real answer and yields the default. A long-lived
 * caller uses `null` to keep its last known scope instead of flipping on one
 * blip.
 */
export async function readWaitlistManagedOnly(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): Promise<boolean | null> {
	try {
		const response = await fetchForTarget(target)(
			`${baseUrl(target)}/api/feature-flags/public`,
			{ cache: "no-store", signal }
		);
		if (!response.ok) {
			return null;
		}
		return featureResponseSchema.parse(await response.json()).features;
	} catch {
		return null;
	}
}

/** Read the server-controlled waitlist scope, defaulting to all nodes. */
export async function fetchWaitlistManagedOnly(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): Promise<boolean> {
	return (
		(await readWaitlistManagedOnly(target, signal)) ??
		WAITLIST_MANAGED_ONLY_FLAG.defaultValue
	);
}

/** Apply the server's managed-only scope when enabled; otherwise gate every node. */
export async function resolveNodeWaitlistAccess(
	target: WaitlistClientTarget,
	nodeUrl: string,
	signal?: AbortSignal
): Promise<NodeWaitlistAccess> {
	const managedOnly = await fetchWaitlistManagedOnly(target, signal);
	if (managedOnly) {
		const managedNodeUrls = await fetchManagedNodeUrls(target, signal);
		const normalizedUrl = normalizedNodeUrl(nodeUrl);
		if (
			!(
				normalizedUrl &&
				managedNodeUrls?.some((managedUrl) => managedUrl === normalizedUrl)
			)
		) {
			return { scope: "bypassed" };
		}
	}
	return {
		access: await fetchWaitlistAccess(target, signal),
		scope: managedOnly ? "managed" : "all",
	};
}

/** The authenticated user's waitlist record, or null for a dead session. */
export async function fetchWaitlistMe(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): Promise<WaitlistMe | null> {
	const response = await fetchForTarget(target)(
		`${baseUrl(target)}/api/waitlist/me`,
		{
			credentials: "include",
			headers: requestHeaders(target),
			signal,
		}
	);
	if (response.status === 401 || response.status === 403) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`waitlist-${response.status}`);
	}
	const payload: unknown = await response.json();
	const parsed = parseWaitlistMe(payload);
	if (!parsed) {
		throw new Error("waitlist-invalid-response");
	}
	return parsed;
}

/** Resolve the fail-closed access state used by every client gate. */
export async function fetchWaitlistAccess(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): Promise<WaitlistAccess> {
	try {
		const me = await fetchWaitlistMe(target, signal);
		return me?.status ?? "unauthenticated";
	} catch {
		return "unavailable";
	}
}

/** Open the live approval stream used by browser and desktop waitlist pages. */
export function openWaitlistStream(
	target: WaitlistClientTarget,
	signal?: AbortSignal
): AsyncGenerator<SseMessage<WaitlistStatusEvent>> {
	return openSse<WaitlistStatusEvent>(
		`${baseUrl(target)}/api/waitlist/stream`,
		{
			decode: waitlistStatusEventSchema.parse,
			credentials: "include",
			signal,
			token: target.token,
		}
	);
}
