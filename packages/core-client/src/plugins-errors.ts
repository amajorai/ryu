// packages/core-client/src/plugins-errors.ts
//
// Lifecycle error shape, dependency-error rendering, and the failed-response
// parser for Core's Plugin lifecycle endpoints. Re-exported through `./plugins.ts`.

import { z } from "zod";
import { pluginString } from "./plugins-wire.ts";

// ── Error shape returned by lifecycle endpoints ───────────────────────────────

/** A typed dependency-graph failure, mirrored from Core's `DependencyError`
 *  (`apps/core/src/plugins/graph.rs`). Serde-tagged on `code` (snake_case), so a
 *  UI renders "Disable Meetings, Whiteboard first" from the ids — never by
 *  string-parsing a prose message. Returned as `dependency_error` in the 409 body
 *  of `POST /api/plugins/:id/{enable,disable}`. */
export type DependencyError =
	| { code: "not_installed"; plugin: string }
	| { code: "self_dependency"; plugin: string }
	| {
			code: "missing_dependency";
			plugin: string;
			dependency: string;
			required: string | null;
	  }
	| {
			code: "version_mismatch";
			plugin: string;
			dependency: string;
			required: string;
			installed: string;
	  }
	| {
			code: "invalid_version_req";
			plugin: string;
			dependency: string;
			requirement: string;
			reason: string;
	  }
	| { code: "cycle"; cycle: string[] }
	| { code: "blocked_by_dependents"; plugin: string; dependents: string[] }
	| {
			/** An UPDATE was refused because it would break an installed dependent.
			 *  The reverse of `version_mismatch`: the offending version is NOT
			 *  installed yet, so it is reported as `incoming`, never `installed`. */
			code: "dependent_version_mismatch";
			/** The installed dependent that would be left broken. */
			plugin: string;
			/** The plugin being updated. */
			dependency: string;
			/** The requirement `plugin` declares, as written. */
			required: string;
			/** The version `dependency` would be moved to. */
			incoming: string;
	  };

export const dependencyErrorSchema = z.discriminatedUnion("code", [
	z.object({ code: z.literal("not_installed"), plugin: z.string() }),
	z.object({ code: z.literal("self_dependency"), plugin: z.string() }),
	z.object({
		code: z.literal("missing_dependency"),
		plugin: z.string(),
		dependency: z.string(),
		required: z.string().nullable(),
	}),
	z.object({
		code: z.literal("version_mismatch"),
		plugin: z.string(),
		dependency: z.string(),
		required: z.string(),
		installed: z.string(),
	}),
	z.object({
		code: z.literal("invalid_version_req"),
		plugin: z.string(),
		dependency: z.string(),
		requirement: z.string(),
		reason: z.string(),
	}),
	z.object({ code: z.literal("cycle"), cycle: z.array(z.string()) }),
	z.object({
		code: z.literal("blocked_by_dependents"),
		plugin: z.string(),
		dependents: z.array(z.string()),
	}),
	z.object({
		code: z.literal("dependent_version_mismatch"),
		plugin: z.string(),
		dependency: z.string(),
		required: z.string(),
		incoming: z.string(),
	}),
]);
const toDependencyError = dependencyErrorSchema.nullable().catch(null).parse;

/** A failure code added by a newer Core that this client does not recognize yet. */
export interface FutureDependencyFailure {
	code: string;
}

/** Structured error from enable/disable — used to surface Gateway denial,
 *  unreachability, or an unsatisfiable dependency graph via the UI without
 *  leaking raw status codes. */
export interface AppLifecycleError {
	/** True when Core refused because the target is a compiled-in built-in /
	 *  default-on plugin that can only be DISABLED, not uninstalled (409 with
	 *  `code:"built_in"`). The UI branches on this to offer "Disable instead". */
	builtIn: boolean;
	/** The typed dependency failure (HTTP 409), or `null` for other failures. */
	dependencyError: DependencyError | null;
	/** True when the Gateway was unreachable (fail-closed). */
	gatewayUnreachable: boolean;
	/** True when the Gateway denied one or more grants. */
	grantsDenied: boolean;
	/** Core's actionable `hint`, when present (e.g. "disable it instead",
	 *  "pass force=true to override"), else `null`. */
	hint: string | null;
	/** Human-readable reason suitable for display in a UI primitive. */
	message: string;
}

/** Bare full version (`1.2.0`, `1.2.0-beta.1`), as `semver::Version::parse` reads it. */
const BARE_FULL_VERSION =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Bare partial version (`1`, `1.2`), digits only. */
const BARE_PARTIAL_VERSION = /^\d+(?:\.\d+){0,2}$/;

/** Whether a manifest `min_version` is a bare version that Core reads as a floor
 *  (`>= that version`). Mirrors `parse_min_version` in
 *  `crates/core/kernel-contracts`: anything else (`^1.2`, `~1.2`, `>=1.2, <2`,
 *  `1.*`) is comparator syntax Core honours as written, so a client must not
 *  render it as "X or newer" / "≥ X" — the installed version may be too NEW. */
export function isBareVersionFloor(requirement: string): boolean {
	const trimmed = requirement.trim();
	return BARE_FULL_VERSION.test(trimmed) || BARE_PARTIAL_VERSION.test(trimmed);
}

/** Render a {@link DependencyError} as an ACTIONABLE sentence.
 *
 *  `displayName` maps a plugin id to its human name when the caller has the app
 *  list in scope (`(id) => id` is a fine default). The blocked-disable case is the
 *  one a user hits most: Core refuses by default rather than silently cascading, so
 *  the message must name exactly which plugins to disable first. */
export function describeDependencyError(
	input: DependencyError | FutureDependencyFailure,
	displayName: (id: string) => string = (id) => id
): string {
	const err = toDependencyError(input);
	if (!err) {
		return "This change conflicts with the current plugin dependencies.";
	}
	switch (err.code) {
		case "blocked_by_dependents": {
			const names = err.dependents.map(displayName).join(", ");
			return `${displayName(err.plugin)} is needed by ${names}. Disable ${names} first.`;
		}
		case "missing_dependency": {
			let version = "";
			if (err.required) {
				version = isBareVersionFloor(err.required)
					? ` (${err.required} or newer)`
					: ` (${err.required})`;
			}
			return `${displayName(err.plugin)} needs ${displayName(err.dependency)}${version}. Install it first.`;
		}
		case "version_mismatch":
			// A range requirement can fail because the installed version is too NEW,
			// so "update it" is only advice for a bare floor.
			return isBareVersionFloor(err.required)
				? `${displayName(err.plugin)} needs ${displayName(err.dependency)} ${err.required} or newer, but ${err.installed} is installed. Update it first.`
				: `${displayName(err.plugin)} needs ${displayName(err.dependency)} ${err.required}, but ${err.installed} is installed.`;
		case "dependent_version_mismatch":
			// No client update action can send `force`, so only name the fix it can take.
			return `Updating ${displayName(err.dependency)} to ${err.incoming} would break ${displayName(err.plugin)}, which needs ${err.required}. Update ${displayName(err.plugin)} first.`;
		case "invalid_version_req":
			return `${displayName(err.plugin)} declares an invalid version requirement for ${displayName(err.dependency)} ("${err.requirement}"): ${err.reason}.`;
		case "cycle":
			return `Circular dependency: ${err.cycle.map(displayName).join(" → ")}.`;
		case "self_dependency":
			return `${displayName(err.plugin)} declares itself as a dependency.`;
		case "not_installed":
			return `${displayName(err.plugin)} is not installed.`;
		default:
			// A `code` this client does not know yet (Core added a variant). Never
			// crash — fall back to a generic sentence.
			return "This change conflicts with the current plugin dependencies.";
	}
}
// ── Error parser ──────────────────────────────────────────────────────────────

/** Parse the JSON error body from a failed lifecycle response and produce a
 *  structured {@link AppLifecycleError}. Falls back to a generic message when
 *  the body is not JSON. */
export async function parseLifecycleError(
	resp: Response,
	path: string
): Promise<AppLifecycleError> {
	// Keep the actual native JSON.parse return carrier opaque here. Error fields
	// are classified individually below; no object/DTO domain is asserted.
	let body: ReturnType<typeof JSON.parse> = {};
	try {
		const text = await resp.text();
		body = text ? JSON.parse(text) : {};
	} catch {
		// ignore parse errors
	}

	const status = resp.status;
	const rawMessage = pluginString.safeParse(body.message).success
		? pluginString.parse(body.message)
		: pluginString.safeParse(body.error).success
			? pluginString.parse(body.error)
			: `${path} failed: ${status}`;

	// Core answers 403 for more than Gateway grant denials (a `mandatory` plugin,
	// a node-scope/ACL lifecycle refusal). Only the GrantsDenied arm carries
	// `denied_grants`; every other 403 keeps Core's own reason.
	const grantsDenied = status === 403 && Array.isArray(body.denied_grants);
	const lifecyclePermissionDenied =
		status === 403 && body.error === "app_lifecycle_permission_denied";
	const requiredPermission = pluginString.safeParse(body.required_permission)
		.success
		? pluginString.parse(body.required_permission)
		: null;
	const gatewayUnreachable = status === 503;
	// 409 = the dependency graph refused (an enabled dependent blocks a
	// disable/uninstall, a dependency is missing/too old, or the graph cycles).
	// Core nothing-flipped, and the typed payload names the ids involved.
	const dependencyError =
		status === 409 ? toDependencyError(body.dependency_error) : null;
	// 409 `code:"built_in"` = uninstall refused because the target is compiled into
	// the binary (only disable is possible). Distinct from the dependency refusal.
	const builtIn = status === 409 && body.code === "built_in";
	const hint = pluginString.safeParse(body.hint).success
		? pluginString.parse(body.hint)
		: null;

	let message = rawMessage;
	if (dependencyError) {
		message = describeDependencyError(dependencyError);
	} else if (lifecyclePermissionDenied) {
		message = requiredPermission
			? `You don't have permission (${requiredPermission}) to change apps on this node.`
			: "You don't have permission to change apps on this node.";
	} else if (grantsDenied) {
		const denied = Array.isArray(body.denied_grants)
			? body.denied_grants.join(", ")
			: null;
		message = denied
			? `Gateway denied grants: ${denied}`
			: "Gateway denied one or more permission grants.";
	} else if (gatewayUnreachable) {
		const reason = pluginString.safeParse(body.reason).success
			? pluginString.parse(body.reason)
			: "gateway unreachable";
		message = `Gateway unreachable (fail-closed): ${reason}`;
	}

	return {
		message,
		grantsDenied,
		gatewayUnreachable,
		dependencyError,
		builtIn,
		hint,
	};
}
