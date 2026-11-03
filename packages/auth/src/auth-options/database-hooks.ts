import { User } from "@ryu/db/models/auth.model";
import { Member } from "@ryu/db/models/control-plane.model";
import { sendEmail, WaitlistConfirmationEmail } from "@ryu/email";
import type { BetterAuthOptions } from "better-auth";
import {
	ensurePersonalOrganization,
	resolveInitialActiveOrganization,
} from "../lib/organizations.ts";
import { syncPolarCustomer } from "../lib/payments.ts";
import {
	creditPendingReferral,
	creditReferrerAtSignup,
} from "../lib/referral-credit.ts";
import { runRefereeGrantHook } from "../lib/referral-grant-hook.ts";
import {
	generateReferralCode,
	referralUrlFor,
	webOrigin,
} from "../lib/waitlist.ts";
import { waitlistPositionFor } from "../lib/waitlist-queue.ts";

import { authApi } from "./auth-instance.ts";
import { recordLoginAndNotifyStaleAccount } from "./login-activity.ts";
import { referredByFromCookie } from "./origins.ts";
import { resolveSignupRole, userHookFieldsSchema } from "./schemas.ts";
import { reconcileAdminRole } from "./team-claims.ts";

// Database hooks for sessions and users: personal organizations, signup
// roles, referrals and admin role reconciliation.

export const databaseHooks = {
	session: {
		create: {
			before: async (session: { userId: string }) => {
				// Anonymous sessions are intentionally account-less. Do not create a
				// personal organization or reconcile account roles for a guest: those
				// hooks are for durable accounts and would turn every guest visit into
				// a Polar customer, waitlist row, and organization.
				try {
					const user = await User.findById(session.userId)
						.select("isAnonymous")
						.lean<{ isAnonymous?: boolean }>();
					if (user?.isAnonymous) {
						return { data: session };
					}
				} catch {
					// Preserve the existing fail-open session path if the auxiliary
					// Mongoose read is unavailable.
				}
				// Make the stored role agree with the admin allowlist before the
				// session exists, so the very first render of this session already
				// shows an allowlisted admin their admin affordances.
				await reconcileAdminRole(session.userId);
				// Start every new session scoped to the user's default org so
				// org-scoped reads (the control plane reads the `member` collection)
				// resolve immediately on first login. Earliest membership = the
				// default org created at sign-up.
				//
				// A user with NO membership is repaired here rather than left
				// unscoped. That state is reachable two ways — an account created
				// before auto-provisioning landed, or a sign-up whose fail-open
				// `ensurePersonalOrganization` threw — and it is not a cosmetic
				// "Select organization" prompt: org-scoped routes REFUSE such a
				// caller, so `/api/credits/wallet` 409s on every request and every
				// SSE reconnect until the membership exists.
				//
				// Fail-open as before: any error leaves the session without an active
				// org rather than blocking login.
				try {
					const activeOrganizationId = await resolveInitialActiveOrganization({
						userId: session.userId,
						findEarliestMembership: async (userId) => {
							const member = await Member.findOne({ userId })
								.sort({ createdAt: 1 })
								.lean();
							return member?.organizationId
								? String(member.organizationId)
								: null;
						},
						ensureOrganization: async (userId) => {
							await ensurePersonalOrganization(userId, authApi());
						},
					});
					if (activeOrganizationId) {
						return {
							data: { ...session, activeOrganizationId },
						};
					}
				} catch (error) {
					console.error(
						"Failed to resolve initial active organization:",
						error
					);
				}
			},
			after: async (session) => {
				void recordLoginAndNotifyStaleAccount(session);
			},
		},
	},
	user: {
		create: {
			before: async (user, context) => {
				if (userHookFieldsSchema.parse(user).isAnonymous) {
					return { data: user };
				}
				// Stamp every new user with a referral code. Normalize any inbound
				// referral code to the canonical upper-case form.
				const inboundReferredBy = userHookFieldsSchema.parse(user).referredBy;
				// Email/password sign-up threads `referredBy` in the body (wins here);
				// social/OAuth sign-up has no body, so fall back to the `ryu_ref`
				// cookie the web client set at the ?ref= landing. Without this,
				// Google-referred signups silently attribute to no one.
				const rawReferredBy =
					inboundReferredBy || referredByFromCookie(context);
				const referredBy = rawReferredBy
					? rawReferredBy.trim().toUpperCase()
					: undefined;
				type SignupUserCreateData = typeof user & {
					emailVerifiedAt?: Date;
					referralCode: string;
					referralCount: number;
					referredBy?: string;
					role: string;
				};
				// The role is written with the insert, so no committed account ever
				// carries the admin plugin's default "user" (which the waitlist
				// treats as approved). Better Auth 1.7.1 runs plugin hooks first and
				// `databaseHooks` last (context/helpers.mjs), spreading each result
				// over the previous one (db/with-hooks.mjs), so this `role` replaces
				// the admin plugin's `{ role: "user", ...user }` and any role the
				// caller passed (admin createUser, SCIM, SSO). The adapter writes
				// every declared field whatever its `input` flag, so `role` and
				// `emailVerifiedAt` reach the document.
				const data: SignupUserCreateData = {
					...user,
					referralCode: generateReferralCode(),
					referralCount: 0,
					role: resolveSignupRole(user).role,
				};
				if (user.emailVerified) {
					data.emailVerifiedAt = new Date();
				}
				if (referredBy) {
					data.referredBy = referredBy;
				}
				return { data };
			},
			after: async (user: {
				id: string;
				email: string;
				name?: string;
				emailVerified?: boolean;
				isAnonymous?: boolean;
				role?: string;
				referralCode?: string;
				referralCount?: number;
				referredBy?: string;
			}) => {
				if (user.isAnonymous) {
					return;
				}
				// Credit the referrer (if any) so referrals move them up the queue —
				// at once for a verified referee, otherwise when the mailbox is
				// verified. Best-effort: a bad/unknown code just means no credit.
				await creditReferrerAtSignup(user);
				// The role (and `emailVerifiedAt`, and the referral code) were
				// written with the insert by `user.create.before`; the queue
				// decision is recomputed from the same helper rather than trusted
				// from this hook's argument.
				const { queued } = resolveSignupRole(user);
				const referralCode = user.referralCode;
				// Welcome queued users with their position and personal referral link.
				// Admins and auto-approved (waitlist-bypassed) users skip this — they
				// were never in the queue, so a position email would be wrong.
				if (queued) {
					try {
						const position = await waitlistPositionFor(user.id);
						const referralUrl = referralCode
							? referralUrlFor(referralCode)
							: `${webOrigin()}/login?view=signup`;
						await sendEmail({
							to: user.email,
							subject: "You're on the list, here's what's next",
							react: WaitlistConfirmationEmail({
								name: user.name,
								position,
								referralUrl,
							}),
							// Fires right after the verification email — bypass the cooldown
							// so it isn't silently dropped.
							skipRateLimit: true,
						});
					} catch (error) {
						console.error("Failed to send waitlist confirmation email:", error);
					}
				}
				// Give every new user a default organization so they always have a
				// valid org context. Wrapped so a failure here never fails sign-up,
				// exactly like the Polar provisioning above.
				try {
					await ensurePersonalOrganization(user.id, authApi());
				} catch (error) {
					console.error(
						"Failed to create default organization for user:",
						error
					);
				}
				// The referee's sign-up credit, if they arrived on someone's link.
				// STRICTLY AFTER the default organization: the grant lands in an
				// ORG wallet, so a referee with no membership yet has nowhere to put
				// it and the money is simply never minted.
				//
				// Deliberately UNCONDITIONAL — not gated on `user.referredBy`. The
				// implementation re-reads the stored code itself (its fast path for
				// the ~everyone who has none), and the `before` hook may have written
				// a code this hook's `user` object never carried: a social sign-up
				// has no request body, so its code comes from the `ryu_ref` cookie.
				// Swallows its own failures (see `runRefereeGrantHook`), like
				// `ensurePersonalOrganization` and `syncPolarCustomer` here.
				await runRefereeGrantHook(user.id);
			},
		},
		update: {
			after: async (user: {
				id: string;
				email: string;
				emailVerified?: boolean;
				name?: string;
			}) => {
				// Email-OTP sign-in, magic links and OAuth account linking verify
				// a mailbox through `updateUser` without `afterEmailVerification`,
				// so settle a pending referral credit here too (at most once).
				if (user.emailVerified) {
					await creditPendingReferral(user.id);
					await reconcileAdminRole(user.id);
				}
				await syncPolarCustomer({
					id: user.id,
					email: user.email,
					name: user.name,
				});
			},
		},
	},
} satisfies NonNullable<BetterAuthOptions["databaseHooks"]>;
