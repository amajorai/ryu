// packages/services-cli/src/commands/passport.ts
//
// `ryu-services passport …`: Ryu Passport commands. All of them read:
//
//   capabilities
//   profiles
//   connections list
//   connections get <id>
//   usage [--from ISO] [--to ISO]
//
// Configuration comes from RYU_PASSPORT_URL and RYU_PASSPORT_API_KEY (the
// tenant administration token), or --base-url / --api-key. With only
// RYU_PASSPORT_RUNTIME_KEY (the setup agents are given), `connections list`
// lists the runtime grant's connections instead, as the MCP
// `passport_list_connections` tool does; the other commands need the
// administration token. Creating,
// importing and deleting connections are left to the SDK or the Passport API
// on purpose: a CLI retry of a create could duplicate a connection.

import {
	createRyuError,
	isRyuError,
	messageWithoutHint,
	type PassportConnectionList,
	type RyuError,
	toResult,
} from "@ryuhq/services";
import { CliUsageError, stringFlag } from "../args.ts";
import { listPage } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";
import { type SettledCall, settled, settledWith } from "../settled.ts";

const HOUR_MS = 3_600_000;

/** An RFC 3339 UTC time without fractional seconds, as Passport's examples write it. */
function wholeHour(ms: number): string {
	return new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * The window `usage` reads when `--from`/`--to` are omitted: the 24 whole UTC
 * hours before the next hour boundary, so the current hour is included.
 */
export function defaultPassportUsageWindow(nowMs: number): {
	from: string;
	to: string;
} {
	const next = Math.ceil(nowMs / HOUR_MS) * HOUR_MS;
	const end = next === nowMs ? next + HOUR_MS : next;
	return { from: wholeHour(end - 24 * HOUR_MS), to: wholeHour(end) };
}

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(ctx.args[0] ?? ctx.rest[0])}.`
		);
	}
}

function requireId(ctx: CommandContext): string {
	const [value, ...extra] = ctx.args;
	if (value === undefined || value === "") {
		throw new CliUsageError("<id> is required.");
	}
	if (extra.length > 0) {
		throw new CliUsageError(`Unexpected argument ${JSON.stringify(extra[0])}.`);
	}
	return value;
}

/** True for the configuration error an administration route raises without RYU_PASSPORT_API_KEY. */
export function isMissingAdminKey(error: unknown): boolean {
	if (!isRyuError(error) || error.code !== "configuration_error") {
		return false;
	}
	const missing = (error.details as { missing?: unknown } | null)?.missing;
	return Array.isArray(missing) && missing.includes("RYU_PASSPORT_API_KEY");
}

/**
 * Whether a runtime grant is configured. With no Passport key at all the SDK
 * check itself raises the missing-key configuration error, which here just
 * means "no".
 */
async function hasRuntimeGrant(ctx: CommandContext): Promise<boolean> {
	try {
		return await ctx.ryu.passport.runtime.connections.hasRuntimeGrant();
	} catch (error) {
		if (isRyuError(error) && error.code === "configuration_error") {
			return false;
		}
		throw error;
	}
}

/**
 * `connections list`: every connection in the tenant with the administration
 * token; with only a runtime grant, the grant's profiles' connections.
 */
async function listConnections(ctx: CommandContext): Promise<SettledCall> {
	rejectArgs(ctx);
	const admin = await toResult(ctx.ryu.passport.connections.list());
	if (admin.error === null) {
		return settledWith(admin.data, admin.meta);
	}
	if (isMissingAdminKey(admin.error) && (await hasRuntimeGrant(ctx))) {
		return settled(ctx.ryu.passport.runtime.connections.list());
	}
	throw isMissingAdminKey(admin.error)
		? withoutEitherKey(admin.error)
		: admin.error;
}

/**
 * The missing-key error for `connections list` with neither key: either key
 * would do, so `details.missing` names both and the CLI hint (hints.ts) says
 * so instead of pointing back at this command.
 */
function withoutEitherKey(error: RyuError): RyuError {
	const { name: _name, ...fields } = error.toJSON();
	const details = (error.details ?? {}) as Record<string, unknown>;
	// `toJSON().message` ends with the SDK hint; the copy is built from the
	// message without it so the CLI hint (hints.ts) is the only one shown.
	return createRyuError({
		...fields,
		message: messageWithoutHint(error),
		cause: error.cause,
		details: {
			...details,
			missing: [...missingVarsOf(details), "RYU_PASSPORT_RUNTIME_KEY"],
		},
	});
}

function missingVarsOf(details: Record<string, unknown>): string[] {
	return Array.isArray(details.missing) ? details.missing.map(String) : [];
}

function usage(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	const from = stringFlag(ctx.flags, "from");
	const to = stringFlag(ctx.flags, "to");
	if ((from === undefined) !== (to === undefined)) {
		throw new CliUsageError("Pass both --from and --to, or neither.");
	}
	const window =
		from === undefined || to === undefined
			? defaultPassportUsageWindow(Date.now())
			: { from, to };
	return ctx.ryu.passport.usage(window);
}

/** Every `ryu-services passport` command. */
export const passportCommands: readonly ServiceCommand[] = [
	{
		path: ["capabilities"],
		summary: "Show the Passport contract version and features.",
		readOnly: true,
		run: (ctx) => {
			rejectArgs(ctx);
			return ctx.ryu.passport.capabilities();
		},
	},
	{
		path: ["profiles"],
		summary:
			"List profiles with their status-only connections, one JSON line each.",
		readOnly: true,
		run: (ctx) => {
			rejectArgs(ctx);
			return listPage(ctx, ctx.ryu.passport.profiles.list(), {
				noun: "profiles",
				items: (page) => page.profiles,
			});
		},
	},
	{
		path: ["connections", "list"],
		summary:
			"List every connection in the tenant (status only, never credentials), one JSON line each; with only RYU_PASSPORT_RUNTIME_KEY, the runtime grant's connections.",
		readOnly: true,
		run: (ctx) =>
			listPage<PassportConnectionList>(ctx, listConnections(ctx), {
				noun: "connections",
				items: (page) => page.connections,
			}),
	},
	{
		path: ["connections", "get"],
		usage: "<id>",
		summary: "Show one connection's status and login-flow state.",
		readOnly: true,
		run: (ctx) => ctx.ryu.passport.connections.get(requireId(ctx)),
	},
	{
		path: ["usage"],
		summary:
			"Show connection-seconds and fetches for whole UTC hours (default: the last 24 hours).",
		readOnly: true,
		flags: {
			from: {
				type: "string",
				valueName: "iso",
				description: "Window start, an RFC 3339 UTC time on a whole hour.",
			},
			to: {
				type: "string",
				valueName: "iso",
				description:
					"Window end (exclusive), on a whole hour, at most 31 days after --from.",
			},
		},
		run: usage,
	},
];
