import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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
	/** The grants the Gateway denied (comma-joined), when it named them. */
	deniedGrants: string | null;
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
	/** Why the Gateway was unreachable, when `gatewayUnreachable`. */
	unreachableReason: string | null;
}

/** English rendering for the thrown `Error.message`; UI re-renders with `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

/** Render a {@link DependencyError} as an ACTIONABLE sentence.
 *
 *  `displayName` maps a plugin id to its human name when the caller has the app
 *  list in scope (`useApps` passes one; the id is the fallback). The blocked-disable
 *  case is the one a user hits most: Core refuses by default rather than silently
 *  cascading, so the message must name exactly which plugins to disable first. */
export function describeDependencyError(
	err: DependencyError,
	tl: LiteralMessage,
	displayName: (id: string) => string = (id) => id
): string {
	switch (err.code) {
		case "blocked_by_dependents": {
			const names = err.dependents.map(displayName).join(", ");
			return tl("{plugin} is needed by {names}. Disable {names} first.", {
				plugin: displayName(err.plugin),
				names,
			});
		}
		case "missing_dependency": {
			const values = {
				plugin: displayName(err.plugin),
				dependency: displayName(err.dependency),
			};
			return err.required
				? tl(
						"{plugin} needs {dependency} ({required} or newer). Install it first.",
						{ ...values, required: err.required }
					)
				: tl("{plugin} needs {dependency}. Install it first.", values);
		}
		case "version_mismatch":
			return tl(
				"{plugin} needs {dependency} {required} or newer, but {installed} is installed. Update it first.",
				{
					plugin: displayName(err.plugin),
					dependency: displayName(err.dependency),
					required: err.required,
					installed: err.installed,
				}
			);
		case "dependent_version_mismatch":
			return tl(
				"Updating {dependency} to {incoming} would break {plugin}, which needs {required}. Update {plugin} first, or force the update.",
				{
					dependency: displayName(err.dependency),
					incoming: err.incoming,
					plugin: displayName(err.plugin),
					required: err.required,
				}
			);
		case "invalid_version_req":
			return tl(
				'{plugin} declares an invalid version requirement for {dependency} ("{requirement}"): {reason}.',
				{
					plugin: displayName(err.plugin),
					dependency: displayName(err.dependency),
					requirement: err.requirement,
					reason: err.reason,
				}
			);
		case "cycle":
			return tl("Circular dependency: {cycle}.", {
				cycle: err.cycle.map(displayName).join(" → "),
			});
		case "self_dependency":
			return tl("{plugin} declares itself as a dependency.", {
				plugin: displayName(err.plugin),
			});
		case "not_installed":
			return tl("{plugin} is not installed.", {
				plugin: displayName(err.plugin),
			});
		default:
			// A `code` this client does not know yet (Core added a variant). Never
			// crash — fall back to a generic sentence.
			return tl("This change conflicts with the current plugin dependencies.");
	}
}

/** Render the Gateway half of a lifecycle refusal (denied grants, or the
 *  fail-closed unreachable case), or `null` when it is neither. Pure over the
 *  structured fields so the UI can re-render it in the viewer's language. */
export function describeGatewayRefusal(
	err: Pick<
		AppLifecycleError,
		"deniedGrants" | "gatewayUnreachable" | "grantsDenied" | "unreachableReason"
	>,
	tl: LiteralMessage
): string | null {
	if (err.grantsDenied) {
		return err.deniedGrants
			? tl("Gateway denied grants: {denied}", { denied: err.deniedGrants })
			: tl("Gateway denied one or more permission grants.");
	}
	if (err.gatewayUnreachable) {
		return tl("Gateway unreachable (fail-closed): {reason}", {
			reason: err.unreachableReason ?? tl("gateway unreachable"),
		});
	}
	return null;
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

	const parsedDenied = z.array(pluginValueSchema).safeParse(body.denied_grants);
	const deniedGrants =
		grantsDenied && parsedDenied.success
			? parsedDenied.data.join(", ") || null
			: null;
	const unreachableReason = gatewayUnreachable
		? (pluginStringField(body.reason) ?? null)
		: null;
	const gatewayRefusal = {
		deniedGrants,
		gatewayUnreachable,
		grantsDenied,
		unreachableReason,
	};

	// The thrown message is English: `useApps` re-renders the dependency and
	// Gateway refusals in the viewer's language (with display NAMES, "Disable
	// Meetings, Whiteboard first") from the structured fields below.
	let message = rawMessage;
	if (dependencyError) {
		message = describeDependencyError(dependencyError, englishMessages);
	} else if (
		status === 409 &&
		pluginStringField(pluginRecord(body.dependency_error)?.code) !== undefined
	) {
		message = englishMessages(
			"This change conflicts with the current plugin dependencies."
		);
	} else {
		message =
			describeGatewayRefusal(gatewayRefusal, englishMessages) ?? message;
	}

	return { message, dependencyError, status, ...gatewayRefusal };
}
