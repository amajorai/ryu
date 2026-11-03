import { Member } from "@ryu/db/models/control-plane.model";
import { PasswordChangeEmail, sendEmail } from "@ryu/email";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import {
	organizationAuditDetails,
	recordOrganizationControlAudit,
} from "../lib/control-audit-recorder.ts";
import { disableFamilyBotGrantsOnMemberExit } from "../lib/family-bot-grants.ts";
import { invitationEmailNotSentError } from "../lib/invitation-email-delivery.ts";
import {
	loginAssuranceAfterFactor,
	loginAssuranceAfterMagicLinkRequest,
	loginAssuranceAfterPassword,
} from "../lib/login-assurance.ts";
import { organizationMutationSucceeded } from "../lib/organization-mutation-result.ts";
import { successfulResentInvitationSeat } from "../lib/resent-invitation-seat.ts";
import { refreshSessionCookieFromStore } from "../lib/session-cache.ts";
import { settleSsoMembership } from "../lib/sso-membership.ts";
import { providerIdFromSsoCallbackPath } from "../lib/sso-organization.ts";
import { organizationAdmission } from "./admission.ts";
import { authApi } from "./auth-instance.ts";
import {
	restoreInvitationAfterUnsentResend,
	returnedInvitationId,
	takeUnsentInvitationEmail,
} from "./invitation-emails.ts";
import {
	leftMemberSchema,
	refreshResentInvitationSeat,
	releaseSeatClaims,
	revokeRemovedMemberGrants,
} from "./member-grants.ts";
import { auditReturnSchema, organizationHookBodySchema } from "./schemas.ts";

// The global after hook: invitation resend bookkeeping, organization audit,
// login assurance and SSO membership settlement.

export const afterAuthHook = createAuthMiddleware(async (ctx) => {
	// Better Auth stores active organization and active team on the same
	// session. A team from the previous organization must never survive an
	// organization switch and accidentally become the next request's scope.
	if (
		ctx.path === "/organization/set-active" ||
		ctx.path === "/organization/delete"
	) {
		const sessionToken = ctx.context.session?.session.token;
		if (sessionToken) {
			try {
				await ctx.context.internalAdapter.updateSession(sessionToken, {
					activeTeamId: null,
					updatedAt: new Date(),
				});
				await refreshSessionCookieFromStore(ctx, sessionToken);
			} catch (error) {
				console.error("Failed to clear active organization team:", error);
			}
		}
	}
	if (ctx.path === "/organization/invite-member") {
		// A resend whose email was not sent: Better Auth answered with the
		// invitation, but the owner must learn the email did not go out.
		const resentId = returnedInvitationId(ctx.context.returned);
		const unsentResend = resentId
			? await takeUnsentInvitationEmail(resentId)
			: null;
		if (unsentResend && organizationMutationSucceeded(ctx.context.returned)) {
			await restoreInvitationAfterUnsentResend(
				ctx.context.adapter,
				unsentResend
			);
			throw invitationEmailNotSentError(unsentResend.error, "resend");
		}
		const body = organizationHookBodySchema.parse(ctx.body);
		const resentSeat = successfulResentInvitationSeat({
			returned: ctx.context.returned,
			resend: body?.resend,
		});
		if (resentSeat) {
			try {
				await refreshResentInvitationSeat(resentSeat);
			} catch (error) {
				// Keep a completed resend successful if seat maintenance is unavailable.
				console.error(
					"Failed to refresh resent organization invitation seat:",
					error
				);
			}
		}
	}

	// Better Auth owns the organization/member/team mutations themselves, so
	// they do not pass through the Hono control-plane router middleware. Keep
	// the audit append at this post-success hook: the session is authenticated,
	// the mutation has completed, and only stable ids are persisted.
	const organizationAuditActions = new Map(
		Object.entries({
			"/organization/add-member": {
				action: "member.add",
				target: "member",
			},
			"/organization/accept-invitation": {
				action: "invitation.accept",
				target: "invitation",
			},
			"/organization/add-team-member": {
				action: "team.member.add",
				target: "team-member",
			},
			"/organization/create-team": {
				action: "team.create",
				target: "team",
			},
			"/organization/create": {
				action: "organization.create",
				target: "organization",
			},
			"/organization/cancel-invitation": {
				action: "invitation.cancel",
				target: "invitation",
			},
			"/organization/delete": {
				action: "organization.delete",
				target: "organization",
			},
			"/organization/invite-member": {
				action: "member.invite",
				target: "member",
			},
			"/organization/leave": {
				action: "organization.leave",
				target: "organization",
			},
			"/organization/remove-member": {
				action: "member.remove",
				target: "member",
			},
			"/organization/remove-team": {
				action: "team.remove",
				target: "team",
			},
			"/organization/remove-team-member": {
				action: "team.member.remove",
				target: "team-member",
			},
			"/organization/reject-invitation": {
				action: "invitation.reject",
				target: "invitation",
			},
			"/organization/set-active": {
				action: "organization.set-active",
				target: "organization",
			},
			"/organization/set-active-team": {
				action: "team.set-active",
				target: "team",
			},
			"/organization/update": {
				action: "organization.update",
				target: "organization",
			},
			"/organization/update-member-role": {
				action: "member.role.update",
				target: "member",
			},
			"/organization/update-team": {
				action: "team.update",
				target: "team",
			},
		})
	);
	const auditAction = organizationAuditActions.get(ctx.path);
	const session = ctx.context.session;
	const body = organizationHookBodySchema.parse(ctx.body);
	if (
		ctx.path === "/organization/remove-team-member" &&
		session?.session.token &&
		session.session.activeTeamId &&
		body.teamId === session.session.activeTeamId &&
		body.userId === session.user.id
	) {
		try {
			await ctx.context.internalAdapter.updateSession(session.session.token, {
				activeTeamId: null,
				updatedAt: new Date(),
			});
		} catch (error) {
			console.error("Failed to clear removed active team:", error);
		}
	}
	const returned = auditReturnSchema.parse(ctx.context.returned);
	const returnedOrganization = returned.organization;
	const returnedInvitation = returned.invitation;
	const returnedMember = returned.member;
	const returnedTeam = returned.team;
	const returnedOrganizationId = [
		returnedOrganization.id,
		returned.organizationId,
		returnedInvitation.organizationId,
		returnedMember.organizationId,
		returnedTeam.organizationId,
		returned.id,
	].find((value) => Boolean(value?.trim().length));
	const organizationId =
		auditAction?.action === "organization.create"
			? returnedOrganizationId
			: body.organizationId === undefined
				? (returnedOrganizationId ?? session?.session.activeOrganizationId)
				: body.organizationId;
	if (
		auditAction &&
		organizationId &&
		session?.user?.id &&
		organizationMutationSucceeded(ctx.context.returned)
	) {
		const targetId =
			(["memberId", "userId", "teamId", "invitationId"] as const).reduce<
				string | null
			>((found, key) => {
				if (found) {
					return found;
				}
				const value = body[key];
				return value?.trim() ? value : null;
			}, null) ?? organizationId;
		try {
			// Through the API's writer, so the row also reaches the org's
			// SIEM stream (see control-audit-recorder.ts).
			await recordOrganizationControlAudit({
				action: auditAction.action,
				actorId: session.user.id,
				actorType: "user",
				details: await organizationAuditDetails({
					memberId: body.memberId ?? returned.id,
					method: String(ctx.method),
					path: ctx.path,
					role: returned.role,
				}),
				organizationId,
				target: auditAction.target,
				targetId,
			});
		} catch (error) {
			// Never turn a completed Better Auth mutation into a failed auth
			// response because the optional audit projection is unavailable.
			console.error("Failed to append organization control audit:", error);
		}
	}
	// `/organization/leave` runs none of Better Auth's member hooks, so the
	// seat claim and custom-role grants are released here instead.
	if (
		ctx.path === "/organization/leave" &&
		organizationMutationSucceeded(ctx.context.returned)
	) {
		const left = leftMemberSchema.safeParse(ctx.context.returned);
		if (left.success) {
			try {
				await releaseSeatClaims(left.data);
			} catch (error) {
				console.error("Failed to release a leaving member's seat:", error);
			}
			await revokeRemovedMemberGrants(left.data);
			await disableFamilyBotGrantsOnMemberExit(left.data);
			await organizationAdmission.releaseMemberFamilyPlace(left.data);
		}
	}
	const loginAssuranceResponse = await loginAssuranceAfterPassword(ctx);
	if (loginAssuranceResponse) {
		return loginAssuranceResponse;
	}
	await loginAssuranceAfterMagicLinkRequest(ctx);
	await loginAssuranceAfterFactor(ctx);

	if (ctx.path === "/change-password") {
		const session = ctx.context.session;
		if (session?.user) {
			try {
				await sendEmail({
					to: session.user.email,
					subject: "Your new password is live",
					react: PasswordChangeEmail({
						userName: session.user.name || undefined,
					}),
				});
			} catch (error) {
				console.error(
					"Failed to send password change notification email:",
					error
				);
			}
		}
	}

	// `ctx.path` is the route template here; the id is in `ctx.params`.
	const providerId = providerIdFromSsoCallbackPath(ctx.path, ctx.params);
	const newSession = ctx.context.newSession;
	const sessionToken = newSession?.session?.token;
	const userId = newSession?.user?.id;
	const userEmail = newSession?.user?.email;
	if (!(providerId && sessionToken && userId && userEmail)) {
		return;
	}

	try {
		const provider = z
			.object({ organizationId: z.string().nullable().catch(null) })
			.nullable()
			.catch(null)
			.parse(
				await ctx.context.adapter.findOne({
					model: "ssoProvider",
					where: [{ field: "providerId", value: providerId }],
				})
			);
		const organizationId = provider?.organizationId;
		if (!organizationId) {
			return;
		}

		// Plugin provisioning is disabled in `sso()` below because it writes
		// the member row past `beforeAddMember`. Admit through the
		// organization plugin instead, so the paid-seat reservation and the
		// verified business-email gate apply exactly as for invitations.
		const membership = await settleSsoMembership(
			{ organizationId, user: { email: userEmail, id: userId } },
			{
				addMember: async (member) => {
					await authApi().addMember({
						body: { ...member, role: "member" },
					});
				},
				hasPendingInvitation: async ({ email }) =>
					Boolean(
						await ctx.context.adapter.findOne({
							model: "invitation",
							where: [
								{ field: "organizationId", value: organizationId },
								{ field: "email", value: email },
								{ field: "status", value: "pending" },
								{
									field: "expiresAt",
									operator: "gt",
									value: new Date(),
								},
							],
						})
					),
				isMember: async (member) =>
					Boolean(await Member.findOne(member).select("_id").lean()),
			}
		);
		if (membership.kind === "refused") {
			// The identity is proven, so the sign-in still completes; only the
			// organization access waits for a free seat or a verified email.
			console.warn(
				"SSO sign-in did not add an organization member:",
				membership.error instanceof Error
					? membership.error.message
					: membership.error
			);
			return;
		}
		if (membership.kind === "invitation-pending") {
			return;
		}

		const activeOrganizationId = newSession.session.activeOrganizationId;
		if (activeOrganizationId === organizationId) {
			return;
		}

		await ctx.context.internalAdapter.updateSession(sessionToken, {
			activeOrganizationId: organizationId,
			updatedAt: new Date(),
		});
		await refreshSessionCookieFromStore(ctx, sessionToken);
	} catch (error) {
		console.error("Failed to select the SSO organization:", error);
	}
});
