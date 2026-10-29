// `ryu-cli sessions`: account sessions on the auth backend, plus the parsers the
// account commands share.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { accountBackendTarget } from "../../core/authBackend.ts";
import { tf, tr } from "../../i18n/translate.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";
import {
	asRecord,
	type CommandJsonValue,
	callCore,
	commandJsonSchema,
	commandSessionReceiptSchema,
	isCommandString,
	outputCommandResult,
} from "./shared.ts";

interface AuthSessionView {
	createdAt?: string;
	expiresAt?: string;
	id: string;
	ipAddress?: string;
	isCurrent: boolean;
	userAgent?: string;
	userId?: string;
}

function parseAuthSessions(value: CommandJsonValue): AuthSessionView[] {
	const payload = asRecord(value);
	if (!(payload && Array.isArray(payload.sessions))) {
		throw new Error("The account service returned an invalid sessions list.");
	}
	const sessions: AuthSessionView[] = [];
	for (const item of payload.sessions) {
		const session = asRecord(item);
		if (!(session && isCommandString(session.id)) || session.id.length === 0) {
			throw new Error("The account service returned an unreadable session.");
		}
		sessions.push({
			createdAt: isCommandString(session.createdAt)
				? session.createdAt
				: undefined,
			expiresAt: isCommandString(session.expiresAt)
				? session.expiresAt
				: undefined,
			id: session.id,
			isCurrent: session.isCurrent === true,
			ipAddress: isCommandString(session.ipAddress)
				? session.ipAddress
				: undefined,
			userAgent: isCommandString(session.userAgent)
				? session.userAgent
				: undefined,
			userId: isCommandString(session.userId) ? session.userId : undefined,
		});
	}
	return sessions;
}

export async function authBackendTarget(ctx: CliContext): Promise<ApiTarget> {
	const status = asRecord(
		await callCore(ctx, "/api/auth/status", { method: "GET" })
	);
	const token = isCommandString(status?.token) ? status.token.trim() : "";
	if (status?.authenticated !== true || token.length === 0) {
		throw new Error(
			"No local account session is available to this CLI. Sign in through Core on this device first."
		);
	}
	return accountBackendTarget(token);
}

export async function loadAuthSessions(
	target: ApiTarget
): Promise<AuthSessionView[]> {
	return parseAuthSessions(
		commandJsonSchema.parse(
			await request(target, "/api/sessions", undefined, appResponseValueSchema)
		)
	);
}

interface AuthUserView {
	email: string | null;
	emailVerified: boolean;
	id: string | null;
	name: string | null;
	twoFactorEnabled: boolean;
}

export async function loadAuthUser(target: ApiTarget): Promise<AuthUserView> {
	const payload = asRecord(
		await request(
			target,
			"/api/auth/get-session",
			undefined,
			appResponseValueSchema
		)
	);
	const user = asRecord(payload?.user);
	if (!user) {
		throw new Error("No signed-in user was returned by the account service.");
	}
	return {
		email: isCommandString(user.email) ? user.email : null,
		emailVerified: user.emailVerified === true,
		id: isCommandString(user.id) ? user.id : null,
		name: isCommandString(user.name) ? user.name : null,
		twoFactorEnabled: user.twoFactorEnabled === true,
	};
}

/** Name, email and user id lines, shared by `whoami` and `account`. */
export function authUserLines(
	user: Pick<AuthUserView, "email" | "emailVerified" | "id" | "name">
): string[] {
	const email = user.email ?? "—";
	return [
		tf("Name: {name}", { name: user.name ?? "—" }),
		user.emailVerified
			? tf("Email: {email} (verified)", { email })
			: tf("Email: {email} (unverified)", { email }),
		tf("User ID: {id}", { id: user.id ?? "—" }),
	];
}

export function twoFactorLine(enabled: boolean): string {
	return enabled
		? tr("Two-factor authentication: enabled")
		: tr("Two-factor authentication: disabled");
}

export function formatAuthUser(user: AuthUserView): string {
	return [...authUserLines(user), twoFactorLine(user.twoFactorEnabled)].join(
		"\n"
	);
}

/** One `sessions` list line: which device, its user agent, id and address. */
function sessionLine(session: AuthSessionView): string {
	const device = session.userAgent ?? tr("Unknown device");
	const address = session.ipAddress ? ` · ${session.ipAddress}` : "";
	const line = session.isCurrent
		? tf("This device: {device} · {id}", { device, id: session.id })
		: tf("Other device: {device} · {id}", { device, id: session.id });
	return `${line}${address}`;
}

export const sessionsCommand: Command = {
	name: "sessions",
	summary: "List or revoke signed-in browser sessions",
	usage: "ryu-cli sessions [revoke <id>|revoke-all --force]",
	run: async (ctx) => {
		const action = ctx.args[0] ?? "list";
		if (action === "list" && ctx.args.length <= 1) {
			const target = await authBackendTarget(ctx);
			const sessions = await loadAuthSessions(target);
			outputCommandResult(
				ctx,
				{ sessions },
				sessions.length === 0
					? tr("No active browser sessions.")
					: [tr("Active browser sessions:"), ...sessions.map(sessionLine)].join(
							"\n"
						)
			);
			return 0;
		}
		if (action === "revoke") {
			if (ctx.args.length !== 2 || !ctx.args[1]) {
				throw new UsageError("Usage: ryu-cli sessions revoke <id>");
			}
			const sessionId = ctx.args[1];
			const target = await authBackendTarget(ctx);
			const sessions = await loadAuthSessions(target);
			const selectedIndex = sessions.findIndex(
				(session) => session.id === sessionId
			);
			if (selectedIndex < 0) {
				throw new Error(
					"That session was not returned by the account service."
				);
			}
			if (sessions[selectedIndex]?.isCurrent) {
				throw new Error("The current device's session cannot be revoked here.");
			}
			if (ctx.flags.dryRun) {
				outputCommandResult(
					ctx,
					{ dryRun: true, sessionId },
					tf("Would revoke session {id}", { id: sessionId })
				);
				return 0;
			}
			const result = await request(
				target,
				`/api/sessions/${encodeURIComponent(sessionId)}`,
				{ method: "DELETE" },
				commandSessionReceiptSchema
			);
			if (result.success !== true) {
				throw new Error(
					result.error ?? "The account service did not confirm the revocation."
				);
			}
			const remaining = await loadAuthSessions(target);
			if (remaining.some((session) => session.id === sessionId)) {
				throw new Error(
					"The session is still active after the revoke request."
				);
			}
			outputCommandResult(
				ctx,
				{ revokedSessionId: sessionId, sessions: remaining },
				tf("Session {id} revoked and confirmed.", { id: sessionId })
			);
			return 0;
		}
		if (action === "revoke-all" && ctx.args.length === 1) {
			if (!(ctx.flags.force || ctx.flags.dryRun)) {
				throw new UsageError(
					"Usage: ryu-cli sessions revoke-all --force (keeps this device signed in)"
				);
			}
			const target = await authBackendTarget(ctx);
			const sessions = await loadAuthSessions(target);
			const currentSession = sessions.find((session) => session.isCurrent);
			const others = sessions.filter((session) => !session.isCurrent);
			if (ctx.flags.dryRun) {
				outputCommandResult(
					ctx,
					{ dryRun: true, otherSessionCount: others.length },
					tf(
						"Would revoke {count, plural, one {# other session} other {# other sessions}}",
						{ count: others.length }
					)
				);
				return 0;
			}
			if (!currentSession) {
				if (sessions.length > 0) {
					throw new Error(
						"The account service did not identify this device's session; reload before revoking others."
					);
				}
				outputCommandResult(
					ctx,
					{ sessions },
					tr("There is no active account session to preserve.")
				);
				return 0;
			}
			const result = await request(
				target,
				"/api/sessions",
				{ method: "DELETE" },
				commandSessionReceiptSchema
			);
			if (result.success !== true) {
				throw new Error(
					result.error ?? "The account service did not confirm the revocation."
				);
			}
			const remaining = await loadAuthSessions(target);
			if (
				!remaining.some(
					(session) => session.id === currentSession.id && session.isCurrent
				) ||
				remaining.some((session) => session.id !== currentSession.id)
			) {
				throw new Error(
					"The account service did not confirm that other sessions ended."
				);
			}
			outputCommandResult(
				ctx,
				{ currentSessionId: currentSession.id, sessions: remaining },
				tf(
					"Revoked {count, plural, one {# other session} other {# other sessions}}; this device remains signed in.",
					{ count: others.length }
				)
			);
			return 0;
		}
		throw new UsageError(
			"Usage: ryu-cli sessions [list|revoke <id>|revoke-all --force]"
		);
	},
};
