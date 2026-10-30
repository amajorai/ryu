import type { DependencyError } from "@ryuhq/core-client/plugins.ts";
import { z } from "zod";
import {
	type PluginDocument,
	pluginDocumentSchema,
	pluginRecord,
	pluginStringField,
	pluginValueSchema,
} from "./plugin-wire-values.ts";

// ── Error shape returned by lifecycle endpoints ───────────────────────────────

/** Structured error from enable/disable — used to surface Gateway denial,
 *  unreachability, or an unsatisfiable dependency graph via the UI without
 *  leaking raw status codes. */
export interface AppLifecycleError {
	/** The typed dependency failure (HTTP 409), or `null` for other failures. */
	dependencyError: DependencyError | null;
	/** True when the Gateway was unreachable (fail-closed). */
	gatewayUnreachable: boolean;
	/** True when the Gateway denied one or more grants. */
	grantsDenied: boolean;
	/** Human-readable reason suitable for display in a UI primitive. */
	message: string;
	/** HTTP status from Core, used for narrow built-in-vs-bundle fallback. */
	status: number;
}

/** Render a {@link DependencyError} as an ACTIONABLE sentence.
 *
 *  `displayName` maps a plugin id to its human name when the caller has the app
 *  list in scope (`useApps` passes one; the id is the fallback). The blocked-disable
 *  case is the one a user hits most: Core refuses by default rather than silently
 *  cascading, so the message must name exactly which plugins to disable first. */
export function describeDependencyError(
	err: DependencyError,
	displayName: (id: string) => string = (id) => id
): string {
	switch (err.code) {
		case "blocked_by_dependents": {
			const names = err.dependents.map(displayName).join(", ");
			return `${displayName(err.plugin)} is needed by ${names}. Disable ${names} first.`;
		}
		case "missing_dependency": {
			const version = err.required ? ` (${err.required} or newer)` : "";
			return `${displayName(err.plugin)} needs ${displayName(err.dependency)}${version}. Install it first.`;
		}
		case "version_mismatch":
			return `${displayName(err.plugin)} needs ${displayName(err.dependency)} ${err.required} or newer, but ${err.installed} is installed. Update it first.`;
		case "dependent_version_mismatch":
			return `Updating ${displayName(err.dependency)} to ${err.incoming} would break ${displayName(err.plugin)}, which needs ${err.required}. Update ${displayName(err.plugin)} first, or force the update.`;
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

/** Complete dependency-graph refusal serialized by Core's native enum. */
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
]) satisfies z.ZodType<DependencyError>;
function toDependencyError(
	value: Parameters<typeof dependencyErrorSchema.parse>[0]
): DependencyError | null {
	const parsed = dependencyErrorSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

// ── Error parser ──────────────────────────────────────────────────────────────

/** Parse the JSON error body from a failed lifecycle response and produce a
 *  structured {@link AppLifecycleError}. Falls back to a generic message when
 *  the body is not JSON. */
export async function parseLifecycleError(
	resp: Response,
	path: string
): Promise<AppLifecycleError> {
	let body: PluginDocument = {};
	try {
		const text = await resp.text();
		body = text ? pluginDocumentSchema.parse(JSON.parse(text)) : {};
	} catch {
		// ignore parse errors
	}

	const status = resp.status;
	const rawMessage =
		pluginStringField(body.message) ??
		pluginStringField(body.error) ??
		`${path} failed: ${status}`;

	const grantsDenied = status === 403;
	const gatewayUnreachable = status === 503;
	// 409 = the dependency graph refused (an enabled dependent blocks a disable, a
	// dependency is missing/too old, or the graph cycles). Core flipped nothing, and
	// the typed payload names the ids involved.
	const dependencyError =
		status === 409 ? toDependencyError(body.dependency_error) : null;

	let message = rawMessage;
	if (dependencyError) {
		// Id-only sentence here; `useApps` re-renders it with display NAMES once the
		// app list is in scope ("Disable Meetings, Whiteboard first").
		message = describeDependencyError(dependencyError);
	} else if (
		status === 409 &&
		pluginStringField(pluginRecord(body.dependency_error)?.code) !== undefined
	) {
		message = "This change conflicts with the current plugin dependencies.";
	} else if (grantsDenied) {
		const parsedDenied = z
			.array(pluginValueSchema)
			.safeParse(body.denied_grants);
		const denied = parsedDenied.success ? parsedDenied.data.join(", ") : null;
		message = denied
			? `Gateway denied grants: ${denied}`
			: "Gateway denied one or more permission grants.";
	} else if (gatewayUnreachable) {
		const reason = pluginStringField(body.reason) ?? "gateway unreachable";
		message = `Gateway unreachable (fail-closed): ${reason}`;
	}

	return { message, grantsDenied, gatewayUnreachable, dependencyError, status };
}
