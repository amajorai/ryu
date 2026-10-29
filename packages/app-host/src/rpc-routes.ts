import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

// Route validation for capability-gated host navigation.

export interface RouteClaim {
	path: string;
	title: string;
}

export const routeClaimSchema = z.object({
	path: z.string(),
	title: z.string(),
});
/** Every production host returns the registered path after its existing own-route gate. */
const routeRegistrationFieldsSchema = z.object({ path: z.string() });
export const routeRegistrationRecordSchema = z.custom<
	z.output<typeof routeRegistrationFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		routeRegistrationFieldsSchema.safeParse(value).success
);
export type RouteRegistrationRecord = z.output<
	typeof routeRegistrationRecordSchema
>;

const shellRouteSchema = z.string();

/**
 * The anti-phishing gate (invariant #6). A plugin may claim ONLY its own,
 * namespaced surface: the exact path `/plugin/<pluginId>`. Every other path —
 * a system route (`/agents`, `/settings`), another plugin's route
 * (`/plugin/other`), or a nested/relative variant — is rejected. The `title` may
 * not impersonate system chrome (contain "ryu" or "system"), so a plugin cannot
 * pose as first-party UI in the tab label.
 *
 * Pure so the `system_route_impersonation_rejected` adversarial test can assert
 * it directly, and so the host `registerRoute` service is a one-line call.
 */
export function validatePluginRoute(
	pluginId: string,
	claim: RouteClaim
): boolean {
	if (!routeClaimSchema.safeParse(claim).success) {
		return false;
	}
	// The one legal surface: this plugin's own exact route. `encodeURIComponent`
	// mirrors `pluginCompanionPath` so a claim matches the route the shell mints.
	const ownPath = `/plugin/${encodeURIComponent(pluginId)}`;
	if (claim.path !== ownPath) {
		return false;
	}
	const lowerTitle = claim.title.toLowerCase();
	if (lowerTitle.includes("ryu") || lowerTitle.includes("system")) {
		return false;
	}
	return true;
}

/** The safe first-party route PREFIXES a `shell.openTab` call (grant
 *  `shell:integrate`) may target. Even a GRANTED companion can only open a known
 *  shell destination — the anti-phishing gate layered ON TOP of the grant, the
 *  sibling of {@link validatePluginRoute} (a raw `openTab(anyPath)` would break the
 *  `/plugin/<id>`-only frame containment). See `docs/renderer-host-slice-1.md`. */
export const SHELL_SAFE_ROUTE_PREFIXES = [
	"/chat",
	"/library",
	"/review",
	"/settings",
	"/meetings",
	"/spaces",
] as const;

/**
 * Whether `path` is a shell destination a granted companion may open via
 * `shell.openTab`: an exact or CHILD match of an allowlisted prefix
 * ({@link SHELL_SAFE_ROUTE_PREFIXES}), or the companion's own `/plugin/<id>` surface
 * (`ownPluginPath`, which the host service supplies from `companion.pluginId`).
 *
 * Pure — extracted here (the `validatePluginRoute` precedent) so the anti-phishing
 * allowlist is unit-testable DOM-free. The `${prefix}/` child guard rejects a
 * prefix-collision like `/chatfoo`; another plugin's `/plugin/<other>` is rejected
 * because only THIS plugin's `ownPluginPath` is passed.
 */
export function isShellSafeRoute(path: string, ownPluginPath: string): boolean {
	const parsed = shellRouteSchema.safeParse(path);
	if (!(parsed.success && parsed.data.startsWith("/"))) {
		return false;
	}
	if (path === ownPluginPath || path.startsWith(`${ownPluginPath}/`)) {
		return true;
	}
	return SHELL_SAFE_ROUTE_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`)
	);
}
