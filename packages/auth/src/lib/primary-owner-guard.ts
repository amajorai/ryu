import { User } from "@ryu/db/models/auth.model";
import {
	baRoleHasBilling,
	builtinPermissionsForBaRole,
	isBaObjectId,
	Member,
} from "@ryu/db/models/control-plane.model";
import {
	baRoleHasOwner,
	loadPrimaryOwnerUserId,
	type PrimaryOwnerAction,
	primaryOwnerRefusal,
} from "@ryu/db/models/primary-owner";
import { z } from "zod";
import {
	FAMILY_OWNER_FIXED_MESSAGE,
	FAMILY_OWNER_LEAVE_MESSAGE,
	FAMILY_ROLE_REFUSED_MESSAGE,
} from "./family-admission.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	readOrganizationKind,
} from "./organization-kind.ts";

/**
 * Better Auth routes the role-ladder rules apply to. Better Auth's own
 * organization hooks receive the target but never the acting user, so the
 * rules run in the global `before` hook, where the session is available.
 */
export const PRIMARY_OWNER_GUARDED_PATHS = new Set([
	"/organization/delete",
	"/organization/invite-member",
	"/organization/leave",
	"/organization/remove-member",
	"/organization/update-member-role",
]);

const optionalString = z.string().trim().min(1).optional().catch(undefined);
const guardedBodySchema = z
	.object({
		memberId: optionalString,
		memberIdOrEmail: optionalString,
		organizationId: optionalString,
		role: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.catch(undefined),
	})
	.catch(() => ({}));

interface MemberRow {
	organizationId: string;
	role: string;
	userId: string;
}

export interface PrimaryOwnerLookups {
	findMemberByEmail(
		organizationId: string,
		email: string
	): Promise<MemberRow | null>;
	findMemberById(memberId: string): Promise<MemberRow | null>;
	findMemberByUser(
		organizationId: string,
		userId: string
	): Promise<MemberRow | null>;
	/**
	 * Whether the org is a Ryu Max family workspace. Optional: without it every
	 * refusal keeps the Teams copy.
	 */
	isFamilyOrganization?(organizationId: string): Promise<boolean>;
	primaryOwnerUserId(organizationId: string): Promise<string | null>;
}

function toMemberRow(
	doc: { organizationId: unknown; role?: string; userId: unknown } | null
): MemberRow | null {
	return doc
		? {
				organizationId: String(doc.organizationId),
				role: doc.role ?? "",
				userId: String(doc.userId),
			}
		: null;
}

export const mongoPrimaryOwnerLookups: PrimaryOwnerLookups = {
	async findMemberById(memberId) {
		if (!isBaObjectId(memberId)) {
			return null;
		}
		return toMemberRow(
			await Member.findById(memberId)
				.select("organizationId userId role")
				.lean<{ organizationId: unknown; role?: string; userId: unknown }>()
		);
	},
	async findMemberByUser(organizationId, userId) {
		if (!(isBaObjectId(organizationId) && isBaObjectId(userId))) {
			return null;
		}
		return toMemberRow(
			await Member.findOne({ organizationId, userId })
				.select("organizationId userId role")
				.lean<{ organizationId: unknown; role?: string; userId: unknown }>()
		);
	},
	async findMemberByEmail(organizationId, email) {
		if (!isBaObjectId(organizationId)) {
			return null;
		}
		const user = await User.findOne({ email: email.toLowerCase() })
			.select("_id")
			.lean<{ _id: unknown }>();
		if (!user) {
			return null;
		}
		return toMemberRow(
			await Member.findOne({ organizationId, userId: user._id })
				.select("organizationId userId role")
				.lean<{ organizationId: unknown; role?: string; userId: unknown }>()
		);
	},
	isFamilyOrganization: async (organizationId) =>
		(await readOrganizationKind(organizationId)) === FAMILY_ORGANIZATION_KIND,
	primaryOwnerUserId: loadPrimaryOwnerUserId,
};

function requestedRole(role: string | string[] | undefined): string {
	return (Array.isArray(role) ? role : [role ?? ""]).join(",");
}

/**
 * Granting the additive `billing` role hands out billing management. Only a
 * member whose built-in role already holds `billing.manage` (owners and the
 * Billing role, `billing-scope.ts` `canManageBilling`) may hand it out. Admins
 * do not manage billing, so they cannot grant it either; nor can, for
 * example a Better Auth dynamic role carrying `member:update`, which Ryu
 * treats as a viewer.
 */
async function billingGrantRefusal(input: {
	actorUserId: string;
	currentRole: string;
	lookups: PrimaryOwnerLookups;
	nextRole: string;
	organizationId: string;
}): Promise<string | null> {
	if (
		!baRoleHasBilling(input.nextRole) ||
		baRoleHasBilling(input.currentRole)
	) {
		return null;
	}
	const actor = await input.lookups.findMemberByUser(
		input.organizationId,
		input.actorUserId
	);
	const canManageBilling =
		actor !== null &&
		builtinPermissionsForBaRole(actor.role).has("billing.manage");
	return canManageBilling
		? null
		: "Only members who manage billing can grant the billing role.";
}

interface GuardRequest {
	activeOrganizationId: string | null;
	actorUserId: string;
	body: unknown;
	path: string;
}

/**
 * Which ladder rule refused, so a family can answer in family copy:
 * `role` is an owner or billing grant (neither exists in a family), `owner`
 * protects the fixed family owner, `leave` and `delete` are the owner's own
 * exits.
 */
type LadderRule = "delete" | "leave" | "owner" | "role";

interface LadderRefusal {
	message: string;
	organizationId: string;
	rule: LadderRule;
}

const FAMILY_LADDER_MESSAGES: Record<LadderRule, string> = {
	delete: "Only the family owner can delete this family workspace.",
	leave: FAMILY_OWNER_LEAVE_MESSAGE,
	owner: FAMILY_OWNER_FIXED_MESSAGE,
	role: FAMILY_ROLE_REFUSED_MESSAGE,
};

/**
 * The role-ladder refusal for one Better Auth organization request, or null
 * when it is allowed (or not one of the guarded routes): the primary-owner
 * rules plus the billing-grant ceiling. Unresolvable targets pass through:
 * Better Auth then answers with its own not-found error.
 *
 * In a family workspace the primary owner is the family owner, the Ryu Max
 * subscriber whose personal workspace it is. The same rules apply there (the
 * family admission hooks additionally refuse owner and billing roles), but the
 * refusal speaks family: a family has no ownership transfer to point at.
 */
export async function primaryOwnerRefusalForRequest(
	input: GuardRequest,
	lookups: PrimaryOwnerLookups = mongoPrimaryOwnerLookups
): Promise<string | null> {
	const refusal = await ladderRefusal(input, lookups);
	if (!refusal) {
		return null;
	}
	const family =
		(await lookups.isFamilyOrganization?.(refusal.organizationId)) ?? false;
	return family ? FAMILY_LADDER_MESSAGES[refusal.rule] : refusal.message;
}

/** The acting session the role-ladder hook needs, from whatever the resolver returned. */
const ladderHookSessionSchema = z
	.object({
		session: z.object({ activeOrganizationId: z.string().nullish() }),
		user: z.object({ id: z.string().min(1) }),
	})
	.nullable()
	.catch(null);

export const PRIMARY_OWNER_GUARD_NO_SESSION_MESSAGE =
	"Sign in again to change organization membership.";

export interface PrimaryOwnerHookDecision {
	code: "FORBIDDEN" | "UNAUTHORIZED";
	message: string;
}

/**
 * The Better Auth `hooks.before` decision for a guarded organization route.
 *
 * `resolveSession` must see bearer callers as well as cookie callers (pass
 * `resolveSessionForHook`): the config-level hook runs before the `bearer`
 * plugin's header-to-cookie rewrite, so a cookie-only lookup would resolve no
 * actor for the desktop, CLI or Expo and skip the ladder. Every guarded route
 * requires a session anyway, so a request whose actor cannot be resolved is
 * refused here (fail closed) instead of reaching the endpoint unchecked.
 */
export async function primaryOwnerHookDecision(
	input: {
		body: unknown;
		path: string;
		resolveSession: () => Promise<unknown>;
	},
	lookups: PrimaryOwnerLookups = mongoPrimaryOwnerLookups
): Promise<PrimaryOwnerHookDecision | null> {
	if (!PRIMARY_OWNER_GUARDED_PATHS.has(input.path)) {
		return null;
	}
	const session = ladderHookSessionSchema.parse(await input.resolveSession());
	if (!session) {
		return {
			code: "UNAUTHORIZED",
			message: PRIMARY_OWNER_GUARD_NO_SESSION_MESSAGE,
		};
	}
	const refusal = await primaryOwnerRefusalForRequest(
		{
			activeOrganizationId: session.session.activeOrganizationId ?? null,
			actorUserId: session.user.id,
			body: input.body,
			path: input.path,
		},
		lookups
	);
	return refusal ? { code: "FORBIDDEN", message: refusal } : null;
}

function ladderRuleFor(action: PrimaryOwnerAction): LadderRule {
	switch (action.kind) {
		case "delete-organization":
			return "delete";
		case "leave":
			return "leave";
		case "update-member-role":
			return baRoleHasOwner(action.nextRole) ? "role" : "owner";
		default:
			return "owner";
	}
}

async function ladderRefusal(
	input: GuardRequest,
	lookups: PrimaryOwnerLookups
): Promise<LadderRefusal | null> {
	if (!PRIMARY_OWNER_GUARDED_PATHS.has(input.path)) {
		return null;
	}
	const body = guardedBodySchema.parse(input.body);
	let organizationId = body.organizationId ?? input.activeOrganizationId;
	let action: PrimaryOwnerAction;
	switch (input.path) {
		case "/organization/delete":
			action = { kind: "delete-organization" };
			break;
		case "/organization/leave":
			action = { kind: "leave" };
			break;
		case "/organization/invite-member": {
			if (!organizationId) {
				return null;
			}
			const nextRole = requestedRole(body.role);
			const billing = await billingGrantRefusal({
				actorUserId: input.actorUserId,
				currentRole: "",
				lookups,
				nextRole,
				organizationId,
			});
			if (billing) {
				return { message: billing, organizationId, rule: "role" };
			}
			if (!baRoleHasOwner(nextRole)) {
				return null;
			}
			const primary = await lookups.primaryOwnerUserId(organizationId);
			return primary === null || primary === input.actorUserId
				? null
				: {
						message: "Only the primary owner can invite someone as an owner.",
						organizationId,
						rule: "role",
					};
		}
		case "/organization/remove-member": {
			const key = body.memberIdOrEmail;
			if (!(key && organizationId)) {
				return null;
			}
			const target = key.includes("@")
				? await lookups.findMemberByEmail(organizationId, key)
				: await lookups.findMemberById(key);
			if (!target || target.organizationId !== organizationId) {
				return null;
			}
			action = {
				kind: "remove-member",
				targetRole: target.role,
				targetUserId: target.userId,
			};
			break;
		}
		default: {
			const target = body.memberId
				? await lookups.findMemberById(body.memberId)
				: null;
			if (!target) {
				return null;
			}
			organizationId = target.organizationId;
			const nextRole = requestedRole(body.role);
			const billing = await billingGrantRefusal({
				actorUserId: input.actorUserId,
				currentRole: target.role,
				lookups,
				nextRole,
				organizationId,
			});
			if (billing) {
				return { message: billing, organizationId, rule: "role" };
			}
			action = {
				kind: "update-member-role",
				nextRole,
				targetRole: target.role,
				targetUserId: target.userId,
			};
		}
	}
	if (!organizationId) {
		return null;
	}
	const message = primaryOwnerRefusal({
		action,
		actorUserId: input.actorUserId,
		primaryOwnerUserId: await lookups.primaryOwnerUserId(organizationId),
	});
	return message
		? { message, organizationId, rule: ladderRuleFor(action) }
		: null;
}
