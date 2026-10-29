import { AsyncLocalStorage } from "node:async_hooks";
import type {
	SCIMIdentity,
	SCIMIdentityResolution,
	SCIMIdentityResolutionContext,
	SCIMIdentityResolutionInput,
	SCIMProjectedUserState,
	SCIMProjection,
	SCIMTransactionContext,
} from "@better-auth/scim";
import {
	ADMIN_ROLE,
	APPROVED_ROLE,
	isWaitlistBypassed,
	WAITLIST_ROLE,
} from "./waitlist.ts";

/**
 * SCIM lifecycle wiring for organization access.
 *
 * Ryu scopes every managed SCIM connection to one organization: the
 * connection's `provisioningDomainId` is the organization id. The SCIM plugin
 * itself only deletes the user's sessions when every source is inactive; it
 * never touches organization membership. Without this projection a directory
 * deactivation or delete left the `member` row, its custom-role grants and the
 * member's personal node credentials in place, and the user signed straight
 * back in (passkey, email OTP, magic link) with full organization access.
 *
 * This projection removes the membership inside the SCIM transaction when the
 * directory deactivates or deletes the user's last source in that
 * organization, then runs the same member-exit cleanup as an admin removal
 * after the transaction commits. Projection never grants access: reactivating
 * a directory user does not restore membership; they rejoin through SSO
 * admission or an invitation.
 *
 * Owners are outside SCIM's reach. A SCIM token is issued only to an
 * organization owner or admin who also holds `access.manage` and
 * `members.manage` (`requireScimTokenIssuer` in
 * packages/api/src/routers/enterprise-identity.ts), because this projection
 * can remove admins. Only an owner may remove another owner, so SCIM never links an
 * existing owner account and never removes an owner's membership.
 */

const OWNER_ROLE = "owner";

interface MemberRecord {
	id: string;
	organizationId: string;
	role?: string | null;
	userId: string;
}

interface UserRecord {
	email?: string | null;
	emailVerified?: boolean | null;
	id: string;
}

interface SsoProviderRecord {
	domain?: string | null;
	domainVerified?: boolean | null;
}

interface TeamRecord {
	id: string;
}

/** A membership the projection removed, handed to the post-commit cleanup. */
export interface ScimRemovedMember {
	memberId: string;
	organizationId: string;
	role: string;
	userId: string;
}

export interface ScimDeprovisioningDeps {
	/** Member-exit cleanup and audit, run once the SCIM write commits. */
	afterMemberRemoved(removed: ScimRemovedMember): Promise<void>;
	/** Defers work until the surrounding transaction commits. */
	queueAfterCommit(hook: () => Promise<void>): Promise<void>;
}

const connectionRetirement = new AsyncLocalStorage<true>();

/**
 * Run an admin's SCIM connection revocation. The plugin replays every
 * directory user in the organization while it retires the connection; inside
 * this scope a user left with no participating directory source (every source
 * they have belongs to a retired connection) keeps their membership, because
 * retiring a connection is not the directory saying the person left. Outside
 * it, losing the last participating source (a directory DELETE) removes
 * access.
 */
export function runScimConnectionRetirement<T>(
	retire: () => Promise<T>
): Promise<T> {
	return connectionRetirement.run(true, retire);
}

/** Whether the caller is inside `runScimConnectionRetirement`. */
export function isScimConnectionRetirement(): boolean {
	return connectionRetirement.getStore() === true;
}

function roleIncludesOwner(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.some((part) => part.trim().toLowerCase() === OWNER_ROLE);
}

/**
 * Remove the user's membership in the connection's organization when the
 * directory no longer holds an active source for them there.
 */
export async function reconcileScimMembership(
	state: Pick<
		SCIMProjectedUserState,
		"active" | "provisioningDomainId" | "sources" | "userId"
	>,
	context: SCIMTransactionContext,
	deps: ScimDeprovisioningDeps
): Promise<ScimRemovedMember | null> {
	// `state.sources` already excludes connections that are being, or have
	// been, decommissioned, so a stale row a retired connection left `active`
	// never keeps access alive after a replacement connection deactivates or
	// deletes the user.
	if (state.active || state.sources.some((source) => source.active)) {
		return null;
	}
	if (state.sources.length === 0 && isScimConnectionRetirement()) {
		return null;
	}
	const organizationId = state.provisioningDomainId;
	const member = await context.database.findOne<MemberRecord>({
		model: "member",
		where: [
			{ field: "organizationId", value: organizationId },
			{ field: "userId", value: state.userId },
		],
	});
	if (!member) {
		return null;
	}
	const role = member.role ?? "";
	// Only an owner may remove an owner; the SCIM token belongs to admins. The
	// owner keeps their membership (no error, so connection revocation and
	// group replays that include them still complete); remove or demote them
	// in Ryu instead.
	if (roleIncludesOwner(role)) {
		return null;
	}
	const teams = await context.database.findMany<TeamRecord>({
		model: "team",
		where: [{ field: "organizationId", value: organizationId }],
	});
	if (teams.length > 0) {
		await context.database.deleteMany({
			model: "teamMember",
			where: [
				{
					field: "teamId",
					operator: "in",
					value: teams.map((team) => team.id),
				},
				{ field: "userId", value: state.userId },
			],
		});
	}
	await context.database.delete({
		model: "member",
		where: [{ field: "id", value: member.id }],
	});
	const removed: ScimRemovedMember = {
		memberId: member.id,
		organizationId,
		role,
		userId: state.userId,
	};
	await deps.queueAfterCommit(() => deps.afterMemberRemoved(removed));
	return removed;
}

interface AdminRoleUserRecord {
	emailVerified?: boolean | null;
	id: string;
	role?: string | null;
}

/**
 * Take the platform-admin role off a directory-managed account whose address
 * is no longer proven.
 *
 * Better Auth's SCIM plugin rewrites the email of an account it manages (one
 * it created) on every PUT/PATCH and clears `emailVerified` when the address
 * changes. The allowlist grants `ADMIN_ROLE` only to a verified address, but
 * the stored role outlives the address that earned it: a directory could let
 * the real owner verify an allowlisted address, then rename the account to an
 * address the directory controls and sign in to it with an email code. This
 * runs inside the SCIM write's transaction, after the profile update, and
 * moves an admin whose address is unverified back to the signup role, so the
 * rename and the demotion commit together. A verified admin (including every
 * account SCIM links, which must already be verified) is left alone.
 */
export async function reconcileScimAdminRole(
	state: Pick<SCIMProjectedUserState, "userId">,
	context: SCIMTransactionContext
): Promise<boolean> {
	const user = await context.database.findOne<AdminRoleUserRecord>({
		model: "user",
		where: [{ field: "id", value: state.userId }],
	});
	if (!user || user.role !== ADMIN_ROLE || user.emailVerified === true) {
		return false;
	}
	await context.database.update({
		model: "user",
		where: [
			{ field: "id", value: user.id },
			{ field: "role", value: ADMIN_ROLE },
		],
		update: { role: isWaitlistBypassed() ? APPROVED_ROLE : WAITLIST_ROLE },
	});
	return true;
}

/**
 * The SCIM projection that keeps organization membership in step and never
 * leaves a directory-managed account an admin on an unproven address.
 */
export function createScimMembershipProjection(
	deps: ScimDeprovisioningDeps
): SCIMProjection {
	return {
		async reconcileUser(state, context) {
			await reconcileScimAdminRole(state, context);
			await reconcileScimMembership(state, context, deps);
		},
	};
}

function providerDomains(domain: string | null | undefined): string[] {
	return (domain ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);
}

/**
 * Link an incoming SCIM User to an existing Ryu account only when the
 * account is already a non-owner member of the connection's organization, its
 * email is verified, and that email is on one of the organization's verified
 * SSO domains. Everyone else is created (and conflicts on an existing email),
 * so a SCIM token can never adopt an unrelated account or an owner. Linked
 * accounts keep their profile (`preserve`): the directory controls their
 * lifecycle in this organization, not their sign-in email.
 */
export async function resolveScimUser(
	input: SCIMIdentityResolutionInput,
	context: SCIMIdentityResolutionContext
): Promise<SCIMIdentityResolution> {
	const create: SCIMIdentityResolution = { action: "create" };
	const email = input.resource.primaryEmail.trim().toLowerCase();
	const emailDomain = email.split("@")[1];
	if (!emailDomain) {
		return create;
	}
	const user = await context.database.findOne<UserRecord>({
		model: "user",
		where: [{ field: "email", value: email }],
	});
	if (!(user && user.emailVerified === true)) {
		return create;
	}
	const organizationId = input.provisioningDomainId;
	const member = await context.database.findOne<MemberRecord>({
		model: "member",
		where: [
			{ field: "organizationId", value: organizationId },
			{ field: "userId", value: user.id },
		],
	});
	if (!member || roleIncludesOwner(member.role)) {
		return create;
	}
	const providers = await context.database.findMany<SsoProviderRecord>({
		model: "ssoProvider",
		where: [{ field: "organizationId", value: organizationId }],
	});
	const domainVerified = providers.some(
		(provider) =>
			provider.domainVerified === true &&
			providerDomains(provider.domain).includes(emailDomain)
	);
	if (!domainVerified) {
		return create;
	}
	return { action: "link", profile: "preserve", userId: user.id };
}

/** The SCIM identity hooks: link SSO-first members so SCIM can deprovision them. */
export function createScimIdentity(): SCIMIdentity {
	return { resolveUser: resolveScimUser };
}
