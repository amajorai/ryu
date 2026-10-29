import {
	ControlAuditEvent,
	PLATFORM_CONTROL_AUDIT_ORGANIZATION_ID,
} from "@ryu/db/models/control-audit.model";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { organizationMutationSucceeded } from "./organization-mutation-result.ts";

/**
 * Better Auth `admin` plugin endpoints that change another account, mapped to
 * the stable audit action and target they record. `impersonate-user` is not
 * here: the support-access plugin closes the native route and audits the
 * consented replacement in `SupportAccessAudit`.
 */
export const PLATFORM_ADMIN_AUDIT_ACTIONS = {
	"/admin/ban-user": { action: "platform.user.ban", target: "user" },
	"/admin/create-user": { action: "platform.user.create", target: "user" },
	"/admin/remove-user": { action: "platform.user.remove", target: "user" },
	"/admin/revoke-user-session": {
		action: "platform.user.session.revoke",
		target: "user",
	},
	"/admin/revoke-user-sessions": {
		action: "platform.user.sessions.revoke",
		target: "user",
	},
	"/admin/set-role": { action: "platform.user.role.set", target: "user" },
	"/admin/set-user-password": {
		action: "platform.user.password.set",
		target: "user",
	},
	"/admin/unban-user": { action: "platform.user.unban", target: "user" },
	"/admin/update-user": { action: "platform.user.update", target: "user" },
} as const satisfies Record<string, { action: string; target: string }>;

type PlatformAdminAuditPath = keyof typeof PLATFORM_ADMIN_AUDIT_ACTIONS;

const auditActions: ReadonlyMap<
	string,
	(typeof PLATFORM_ADMIN_AUDIT_ACTIONS)[PlatformAdminAuditPath]
> = new Map(Object.entries(PLATFORM_ADMIN_AUDIT_ACTIONS));

const MAX_FIELD_NAMES = 32;
const MAX_FIELD_NAME_LENGTH = 64;
const MAX_ROLE_LENGTH = 128;

const optionalId = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.optional()
	.catch(undefined);
const roleValue = z
	.union([z.string(), z.array(z.string())])
	.transform((role) =>
		(Array.isArray(role) ? role.join(",") : role).slice(0, MAX_ROLE_LENGTH)
	)
	.optional()
	.catch(undefined);

/**
 * The parts of an admin request body the audit row may keep. Passwords, ban
 * reasons, session tokens and new field values are never read into it.
 */
const auditBodySchema = z
	.object({
		banExpiresIn: z.number().optional().catch(undefined),
		data: z.record(z.string(), z.unknown()).optional().catch(undefined),
		role: roleValue,
		sessionToken: z.string().min(1).optional().catch(undefined),
		userId: optionalId,
	})
	.catch(() => ({
		banExpiresIn: undefined,
		data: undefined,
		role: undefined,
		sessionToken: undefined,
		userId: undefined,
	}));

const returnedUserSchema = z
	.object({ user: z.object({ id: z.string().min(1) }).optional() })
	.catch(() => ({ user: undefined }));

const auditSessionSchema = z
	.object({
		session: z
			.object({ impersonatedBy: z.string().nullish().catch(null) })
			.catch(() => ({ impersonatedBy: null })),
		user: z.object({ id: z.string().min(1) }),
	})
	.nullable()
	.catch(null);

const priorRoleSchema = z
	.object({ role: z.string().nullish() })
	.nullable()
	.catch(null);

const priorSessionSchema = z
	.object({ session: z.object({ userId: z.string().min(1) }) })
	.nullable()
	.catch(null);

interface PriorState {
	priorRole?: string | null;
	sessionUserId?: string;
}

/**
 * State read before the endpoint runs (the role being replaced, the owner of
 * the session being revoked), keyed by the per-request auth context object
 * Better Auth hands to both hook phases. A miss only drops that detail.
 */
const priorStateByRequest = new WeakMap<object, PriorState>();

interface AuditHookContext {
	body?: unknown;
	context: {
		internalAdapter: {
			findSession: (token: string) => Promise<unknown>;
			findUserById: (userId: string) => Promise<unknown>;
		};
		returned?: unknown;
		session?: unknown;
	};
	method?: string;
	path?: string;
}

function changedFieldNames(data: Record<string, unknown> | undefined) {
	if (!data) {
		return undefined;
	}
	return Object.keys(data)
		.filter((key) => key.length > 0 && key.length <= MAX_FIELD_NAME_LENGTH)
		.sort()
		.slice(0, MAX_FIELD_NAMES);
}

async function readPriorState(ctx: AuditHookContext): Promise<void> {
	const body = auditBodySchema.parse(ctx.body);
	try {
		if (ctx.path === "/admin/set-role" && body.userId) {
			const user = priorRoleSchema.parse(
				await ctx.context.internalAdapter.findUserById(body.userId)
			);
			priorStateByRequest.set(ctx.context, {
				priorRole: user?.role?.slice(0, MAX_ROLE_LENGTH) ?? null,
			});
		}
		if (ctx.path === "/admin/revoke-user-session" && body.sessionToken) {
			const found = priorSessionSchema.parse(
				await ctx.context.internalAdapter.findSession(body.sessionToken)
			);
			if (found) {
				priorStateByRequest.set(ctx.context, {
					sessionUserId: found.session.userId,
				});
			}
		}
	} catch (error) {
		// The prior state is optional detail; never block the admin action on it.
		console.error("Failed to read platform admin audit prior state:", error);
	}
}

/** The row recorded for one completed admin action, or null to record none. */
export function platformAdminAuditRow(ctx: AuditHookContext) {
	const entry = ctx.path ? auditActions.get(ctx.path) : undefined;
	if (!(entry && organizationMutationSucceeded(ctx.context.returned))) {
		return null;
	}
	const body = auditBodySchema.parse(ctx.body);
	const session = auditSessionSchema.parse(ctx.context.session);
	const prior = priorStateByRequest.get(ctx.context);
	const targetId =
		ctx.path === "/admin/create-user"
			? (returnedUserSchema.parse(ctx.context.returned).user?.id ?? null)
			: ctx.path === "/admin/revoke-user-session"
				? (prior?.sessionUserId ?? null)
				: (body.userId ?? null);
	const details: Record<string, unknown> = {
		method: ctx.method ?? "POST",
		status: "success",
	};
	if (session?.session.impersonatedBy) {
		details.impersonatedBy = session.session.impersonatedBy;
	}
	if (ctx.path === "/admin/set-role" || ctx.path === "/admin/create-user") {
		details.role = body.role ?? null;
	}
	if (ctx.path === "/admin/set-role" && prior && "priorRole" in prior) {
		details.priorRole = prior.priorRole ?? null;
	}
	if (ctx.path === "/admin/ban-user" && body.banExpiresIn !== undefined) {
		details.banExpiresIn = body.banExpiresIn;
	}
	if (ctx.path === "/admin/update-user" || ctx.path === "/admin/create-user") {
		const fields = changedFieldNames(body.data);
		if (fields) {
			details.fields = fields;
		}
	}
	return {
		action: entry.action,
		actorId: session?.user.id ?? null,
		// No session means trusted server code called `auth.api.*` directly.
		actorType: session ? ("user" as const) : ("system" as const),
		details,
		organizationId: PLATFORM_CONTROL_AUDIT_ORGANIZATION_ID,
		target: entry.target,
		targetId,
	};
}

/**
 * Append-only record of every platform-admin account mutation: who acted (and
 * who they were impersonating as), what they did, and to whom.
 *
 * A plugin rather than a branch in `hooks.after` so bearer callers resolve the
 * same admin session the endpoint ran as. The append runs after the endpoint
 * succeeded; a failed write is logged and never fails the completed mutation,
 * matching the organization audit append.
 */
export function platformAdminAuditPlugin() {
	return {
		id: "ryu-platform-admin-audit",
		hooks: {
			before: [
				{
					matcher: (ctx) =>
						ctx.path === "/admin/set-role" ||
						ctx.path === "/admin/revoke-user-session",
					handler: createAuthMiddleware(async (ctx) => {
						await readPriorState(ctx);
					}),
				},
			],
			after: [
				{
					matcher: (ctx) => Boolean(ctx.path && auditActions.has(ctx.path)),
					handler: createAuthMiddleware(async (ctx) => {
						const row = platformAdminAuditRow(ctx);
						priorStateByRequest.delete(ctx.context);
						if (!row) {
							return;
						}
						try {
							await ControlAuditEvent.create(row);
						} catch (error) {
							console.error("Failed to append platform admin audit:", error);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
