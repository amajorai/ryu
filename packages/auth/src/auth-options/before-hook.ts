import { APIError, createAuthMiddleware } from "better-auth/api";
import { rejectClientApiKeyMetadata } from "../lib/api-key-metadata-guard.ts";
import { isCustomRoleWritePath } from "../lib/family-admission.ts";
import {
	GUEST_MODE_DISABLED_MESSAGE,
	shouldRejectGuestSignIn,
} from "../lib/guest-mode.ts";
import { assertPendingEmailMatches } from "../lib/login-assurance.ts";
import { authorizeScopeDefaultsFromStore } from "../lib/oauth-authorize-scope.ts";
import { passwordPolicyRefusal } from "../lib/password-endpoints.ts";
import {
	PRIMARY_OWNER_GUARDED_PATHS,
	primaryOwnerHookDecision,
} from "../lib/primary-owner-guard.ts";
import { rejectReferredByUpdate } from "../lib/referral-attribution-guard.ts";
import { authoritativeAuthContext } from "../lib/session-cache.ts";
import {
	isAllowedSocialSignInProvider,
	SOCIAL_SIGN_IN_PROVIDER,
} from "../lib/social-provider-policy.ts";
import { resolveSessionForHook } from "../lib/step-up-plugin.ts";

import { organizationAdmission } from "./admission.ts";
import { rememberInvitationsBeforeResend } from "./invitation-policy.ts";
import {
	hookActiveOrganizationId,
	organizationHookBodySchema,
} from "./schemas.ts";

// The global before hook: request guards that run ahead of every endpoint.

export const beforeAuthHook = createAuthMiddleware(async (ctx) => {
	// Cache ordinary session display reads only. Auth operations and plugin
	// hooks must see revoked sessions and current account/organization state.
	const override = authoritativeAuthContext(ctx);
	if (override) {
		ctx.query = override.context.query;
	}
	if (ctx.path === "/oauth2/authorize" && override) {
		// Without this, an authorize request that omits `scope` asks for
		// every scope, `mail:manage` included (oauth-authorize-scope.ts).
		// Better Auth reads a POST authorize from the body, a GET from the
		// query, so the default goes wherever the request carries it.
		const defaults = await authorizeScopeDefaultsFromStore(
			{ body: ctx.body, method: ctx.method, query: ctx.query },
			ctx.context.adapter
		);
		if (defaults && "query" in defaults) {
			override.context.query = {
				...override.context.query,
				...defaults.query,
			};
			ctx.query = override.context.query;
		} else if (defaults) {
			const overrideContext: {
				body?: Record<string, unknown>;
				query: typeof override.context.query;
			} = override.context;
			overrideContext.body = defaults.body;
			ctx.body = defaults.body;
		}
	}
	if (shouldRejectGuestSignIn(ctx.path)) {
		throw new APIError("FORBIDDEN", {
			message: GUEST_MODE_DISABLED_MESSAGE,
		});
	}
	// API-key metadata is server-only: a key's class and organization come
	// from its stored configId/referenceId, never from client-written metadata.
	rejectClientApiKeyMetadata(ctx);
	// Referral attribution is fixed at sign-up: `/update-user` may not write
	// `referredBy` (an `input: true` field only so sign-up can carry it).
	rejectReferredByUpdate(ctx);
	if (
		ctx.path === "/organization/invite-member" &&
		(ctx.headers?.get("authorization")?.startsWith("Bearer ") ||
			ctx.headers
				?.get("cookie")
				?.includes(ctx.context.authCookies.sessionToken.name))
	) {
		await rememberInvitationsBeforeResend(
			ctx.context.adapter,
			organizationHookBodySchema.parse(ctx.body)
		);
	}
	if (ctx.path === "/sign-in/social") {
		const body = organizationHookBodySchema.parse(ctx.body);
		if (!isAllowedSocialSignInProvider(body?.provider)) {
			throw new APIError("FORBIDDEN", {
				message: `Social sign-in is available only with ${SOCIAL_SIGN_IN_PROVIDER}.`,
			});
		}
	}
	// Email sign-in gets no account lookup here. Better Auth answers an
	// account without a password exactly like an unknown address (the same
	// INVALID_EMAIL_OR_PASSWORD after the same password hash); a distinct
	// reply would tell callers which addresses hold a passwordless account.
	if (isCustomRoleWritePath(ctx.path)) {
		// Better Auth's dynamic access control is off (custom roles are Ryu's
		// control-plane roles), so these endpoints are not mounted today. A
		// family keeps the built-in owner/organizer/member roles; the role
		// endpoints have no organization hook, so if dynamic roles ever come
		// back the write is still refused here. They default to the
		// session's active organization when the body names none.
		const body = organizationHookBodySchema.parse(ctx.body);
		const organizationId =
			body?.organizationId ??
			hookActiveOrganizationId(await resolveSessionForHook(ctx));
		await organizationAdmission.requireCustomRoleWriteAllowed(organizationId);
	}
	// Every endpoint that stores a password a person chose (sign-up, both
	// resets, change-password) is held to the sign-up rules. It runs before
	// the endpoint, so a refused password does not use up the emailed reset
	// link or code that came with it.
	const passwordRefusal = passwordPolicyRefusal(ctx.path, ctx.body);
	if (passwordRefusal) {
		throw new APIError("BAD_REQUEST", { message: passwordRefusal });
	}
	if (PRIMARY_OWNER_GUARDED_PATHS.has(ctx.path)) {
		// This config hook runs before the bearer plugin's rewrite, so the
		// actor must come from resolveSessionForHook (cookie AND bearer);
		// an unresolved actor is refused rather than skipping the ladder.
		const decision = await primaryOwnerHookDecision({
			body: ctx.body,
			path: ctx.path,
			resolveSession: () => resolveSessionForHook(ctx),
		});
		if (decision) {
			throw new APIError(decision.code, { message: decision.message });
		}
	}
	await assertPendingEmailMatches(ctx);
	return override;
});
