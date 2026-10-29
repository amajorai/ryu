// apps/desktop/src/lib/api/safe-actions.ts
//
// The shell side of the `safe-actions:manage` bridge verb, for the
// `@ryu/safe-actions` Companion. A call goes to Core's app host bridge
// (`safeActions.request`), where Core checks the app's approved grant AND the
// signed-in user's Safe Actions role (org Viewer to read, Admin to change or
// decide on a managed node) and records that user as the reviewer of an approval
// or denial. The sandboxed frame never fetches anything itself, and no identity
// it could supply is ever forwarded. The host-direct route remains only as the
// fallback for an older Core that does not know the method.

import type { SafeActionsRequestPayload } from "@ryu/app-host/rpc";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
	type MountedAppPathInput,
	mountedAppPathInputSchema,
} from "./app-request.ts";
import { type ApiTarget, request } from "./client.ts";
import { pluginHostInvoke, withLegacyBridgeFallback } from "./plugins.ts";

const SAFE_ACTIONS_MOUNT = "/api/tools/plans";
const SAFE_ACTIONS_METHOD = "safeActions.request";
const PARSE_BASE = "http://safe-actions.invalid";
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/** Resolve a sandbox-selected sub-path beneath the fixed Core mount. Query
 * strings are refused: this v1 API has no query parameters, keeping the bridge's
 * route set explicit and preventing encoded traversal ambiguities. */
export function resolveSafeActionsPath(
	path: MountedAppPathInput
): string | null {
	const parsed = mountedAppPathInputSchema.safeParse(path);
	if (!parsed.success) {
		return null;
	}
	const relativePath = parsed.data;
	if (
		!relativePath.startsWith("/") ||
		relativePath.startsWith("//") ||
		relativePath.includes("\\") ||
		relativePath.includes("?") ||
		relativePath.includes("#")
	) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(`${SAFE_ACTIONS_MOUNT}${relativePath}`, PARSE_BASE);
	} catch {
		return null;
	}
	if (
		url.pathname !== SAFE_ACTIONS_MOUNT &&
		!url.pathname.startsWith(`${SAFE_ACTIONS_MOUNT}/`)
	) {
		return null;
	}
	return url.pathname;
}

/** The path Core's bridge receives: the normalized path relative to the mount
 *  (Core re-validates it and fixes the mount itself). */
export function toSafeActionsBridgePath(resolved: string): string {
	return resolved.slice(SAFE_ACTIONS_MOUNT.length) || "/";
}

export function safeActionsRequest(
	target: ApiTarget,
	pluginId: string,
	input: SafeActionsRequestPayload
): Promise<AppResponseValue> {
	const resolved = resolveSafeActionsPath(input.path);
	if (!resolved) {
		return Promise.reject(
			new Error("Refusing a request outside the Safe Actions API mount.")
		);
	}
	const method = input.method ?? "GET";
	if (!ALLOWED_METHODS.has(method)) {
		return Promise.reject(
			new Error(`Refusing a Safe Actions request with method "${method}".`)
		);
	}
	const { body } = input;
	return withLegacyBridgeFallback(
		SAFE_ACTIONS_METHOD,
		async () =>
			appResponseValueSchema.parse(
				await pluginHostInvoke(target, pluginId, SAFE_ACTIONS_METHOD, {
					method,
					path: toSafeActionsBridgePath(resolved),
					...(body === undefined ? {} : { body }),
				})
			),
		async () =>
			appResponseValueSchema.parse(
				await request(
					target,
					resolved,
					{ method, body },
					gatewayJsonValueSchema
				)
			)
	);
}
