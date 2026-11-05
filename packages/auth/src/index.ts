import { type Auth, type BetterAuthOptions, betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { afterAuthHook } from "./auth-options/after-hook.ts";
import { registerAuthInstance } from "./auth-options/auth-instance.ts";
import { baseAuthOptions } from "./auth-options/base-options.ts";
import { beforeAuthHook } from "./auth-options/before-hook.ts";
import { databaseHooks } from "./auth-options/database-hooks.ts";
import { emailAuthOptions } from "./auth-options/email-options.ts";
import { configureAuthEmailDelivery } from "./auth-options/email-rate-limit.ts";
import { jwtPlugins } from "./auth-options/jwt-plugin.ts";
import { oauthPlugins } from "./auth-options/oauth-plugins.ts";
import { organizationPlugin } from "./auth-options/organization-plugin.ts";
import {
	accountSessionPlugins,
	deviceSessionPlugins,
} from "./auth-options/session-plugins.ts";
import { signInPlugins } from "./auth-options/sign-in-plugins.ts";
import { loginAssuranceCleanupPlugin } from "./lib/login-assurance.ts";
import { mfaEnrollmentPlugin } from "./lib/mfa-enrollment-plugin.ts";
import { userInMfaRequiredOrganization } from "./lib/org-mfa-membership.ts";
import { platformAdminAuditPlugin } from "./lib/platform-admin-audit-plugin.ts";
import { stepUpGate } from "./lib/step-up-plugin.ts";
import { supportAccessPlugin } from "./lib/support-access-plugin.ts";
import { twoFactorStepUpGate } from "./lib/two-factor-step-up.ts";

export { finalizeCanceledOrganizationInvitation } from "./auth-options/admission.ts";
export { organizationSeatPathForTests } from "./auth-options/seat-claims.ts";

configureAuthEmailDelivery();

const authOptions = {
	...baseAuthOptions,
	...emailAuthOptions,
	hooks: { before: beforeAuthHook, after: afterAuthHook },
	databaseHooks,
	plugins: [
		...signInPlugins,
		...deviceSessionPlugins,
		bearer(),
		...accountSessionPlugins,
		...jwtPlugins,
		...oauthPlugins,
		organizationPlugin,
		loginAssuranceCleanupPlugin(),
		supportAccessPlugin(),
		// Append-only ControlAuditEvent rows for /admin/* account changes
		// (set-role, ban, remove, password, update, create, session revoke).
		platformAdminAuditPlugin(),
		// Mandatory authenticator-or-passkey enrollment: status endpoint plus the
		// guard against removing an account's last strong factor.
		mfaEnrollmentPlugin({ userInMfaRequiredOrganization }),
		// Revealing, re-minting or removing an enrolled authenticator needs a
		// second-factor step-up; first enrollment stays password-gated.
		twoFactorStepUpGate(),
		// LAST on purpose. Before-hooks run in `[config.hooks.before, ...plugins]`
		// order, so this has to sit after `bearer` — which rewrites an
		// `Authorization` header into the session cookie — or the gate resolves no
		// session for token callers and silently waves them through. See the note
		// in lib/step-up-plugin.ts.
		stepUpGate(),
	],
} satisfies BetterAuthOptions;

export const auth: Auth<typeof authOptions> = betterAuth(authOptions);
registerAuthInstance(auth);
