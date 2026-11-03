import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { sso } from "@better-auth/sso";
import { User } from "@ryu/db/models/auth.model";
import { env } from "@ryu/env/server";
import type { BetterAuthOptions } from "better-auth";
import { hasEnterpriseCapability } from "../lib/enterprise-entitlement.ts";
import { scimAdminEmailGuardPlugin } from "../lib/scim-admin-email-guard.ts";
import { resolveEnterpriseSsoUser } from "../lib/sso-enterprise-gate.ts";
import {
	implicitPermissionsForRole,
	OAUTH_OPT_IN_SCOPES,
	RYU_DEFAULT_OAUTH_SCOPES,
	RYU_SUPPORTED_SCOPES,
} from "../scopes.ts";
import { createRyuScimPlugin } from "./identity-plugins.ts";

// API keys, the MCP OAuth provider, client metadata documents, SSO and SCIM.

export const oauthPlugins = [
	// Scoped programmatic access tokens (PATs). Each key carries access-control
	// statements from the shared Ryu scope vocabulary (see scopes.ts) that Core
	// (the resource server) and the Gateway enforce. We deliberately do NOT set
	// enableSessionForAPIKeys: a scoped token must never be silently as powerful
	// as a full login session. Consumers verify + gate via
	// auth.api.verifyApiKey({ body: { key, permissions } }). Personal keys use
	// `references: "user"`; organization keys use the native organization config.
	apiKey([
		{
			// Keep the default config id stable so existing personal keys remain
			// verifiable after the organization config is added.
			configId: "default",
			references: "user",
			enableMetadata: true,
			// The plugin default is 10 verifications per day. The plugin stores the
			// limiter on each key at creation; migration
			// 1791936000000-api-key-rate-limit-backfill raised keys minted on that
			// default to this limiter, and custom limits were left alone.
			rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
			permissions: {
				defaultPermissions: async (referenceId) => {
					try {
						const user = await User.findById(referenceId).lean();
						// The implicit set leaves out opt-in scopes (such as
						// mail:manage), matching classic /me/api-keys tokens.
						return implicitPermissionsForRole(user?.role);
					} catch (error) {
						console.error(
							"[auth] apiKey defaultPermissions lookup failed:",
							error
						);
						// Fail CLOSED. A scoped token defaulting its own ceiling must never
						// widen on error: if we cannot read the role, mint a key with no
						// permissions rather than the write-capable standard set (which is
						// what an absent role resolves to). The caller can always pass
						// explicit permissions, and a re-create succeeds once the DB is
						// healthy.
						return {};
					}
				},
			},
		},
		{
			// Organization keys are owned by the Better Auth organization
			// reference itself. Ryu supplies an explicit, role-clamped permission
			// map from the control-plane route; an empty fallback prevents a direct
			// native call from receiving broader Ryu scopes.
			configId: "organization",
			references: "organization",
			enableMetadata: true,
			rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
			permissions: { defaultPermissions: {} },
		},
	]),
	// MCP OAuth: Better Auth's MCP plugin is itself the OAuth 2.1/OIDC provider.
	// It owns the /oauth2/* endpoints and protected-resource discovery, so a
	// separate oauthProvider plugin would register duplicate routes. Tokens are
	// bound to the canonical Ryu MCP resource and the shared Ryu scope vocabulary.
	mcp({
		loginPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/login`,
		consentPage: `${process.env.FRONTEND_URL || "http://localhost:3001"}/oauth/consent`,
		resource: new URL("/mcp", env.BETTER_AUTH_URL).toString(),
		scopes: RYU_SUPPORTED_SCOPES,
		// Opt-in scopes (`mail:manage`) are registrable and grantable, but are
		// requested only by name. Better Auth stores every dynamic or CIMD
		// client with the default-plus-allowed union, `mail:manage` included
		// (the default list only validates a registration that sends no
		// `scope`), and that stored list grants nothing by itself: an authorize
		// request without `scope` is defaulted in `hooks.before` above, and
		// consent leaves the scope unchecked.
		clientRegistrationDefaultScopes: RYU_DEFAULT_OAUTH_SCOPES,
		clientRegistrationAllowedScopes: [...OAUTH_OPT_IN_SCOPES],
		// Discovery (protected-resource and authorization-server metadata)
		// leaves opt-in scopes out. MCP clients request every advertised scope
		// when the 401 challenge names none, so advertising `mail:manage` would
		// put it in every connect request and re-prompt consent each time it
		// is declined. A client learns of it from the `insufficient_scope`
		// challenge `mail_create_inbox` returns (apps/server hosted MCP).
		advertisedMetadata: { scopes_supported: RYU_DEFAULT_OAUTH_SCOPES },
		allowDynamicClientRegistration: true,
		allowUnauthenticatedClientRegistration: true,
		accessTokenExpiresIn: 3600,
		// Hosted MCP access tokens must be revocable immediately. Better Auth's
		// JWT access tokens are intentionally self-contained and its revocation
		// endpoint cannot revoke them, while opaque tokens are checked against the
		// oauthAccessToken row on every protected-resource request.
		disableJwtPlugin: true,
		storeTokens: "hashed",
	}),
	// MCP 2026 clients identify themselves with a Client ID Metadata
	// Document. The Node transport resolves DNS once, rejects special-use IPs,
	// pins the approved address, and refuses redirects. DCR above remains
	// enabled only for compatibility with older MCP clients.
	cimd({
		fetchClientMetadataResource,
		metadataProfile: "mcp-2026-07-28",
	}),
	// Enterprise inbound identity. Provider registration and SCIM token
	// management are exposed through the org-scoped API router, which applies
	// Ryu's entitlement and membership policy before calling these Better Auth
	// endpoints. The protocol endpoints themselves remain available for the
	// hosted login/provisioning flows.
	//
	// Plugin organization provisioning stays disabled. It inserts the member
	// row through the raw adapter, which bypasses `beforeAddMember` and so
	// the paid-seat and business-email gates. Organization-bound SSO callbacks
	// admit through `settleSsoMembership` in the global after hook instead.
	// The plugin's other path, joining an organization on a plain social
	// login because the email domain matches a verified provider, is
	// deliberately not replaced: a matching email domain alone does not grant
	// organization access (see the public enterprise-identity docs). Those
	// users join through SSO or an invitation.
	sso({
		domainVerification: { enabled: true },
		// Live Enterprise entitlement gate, checked after Better Auth has
		// resolved the exact persisted provider and before it creates a user,
		// account, or session: a suspended or expired SSO entitlement stops the
		// protocol itself, not only the management API.
		resolveUser: async (input, context) =>
			await resolveEnterpriseSsoUser(
				input,
				context.database,
				hasEnterpriseCapability
			),
		organizationProvisioning: { disabled: true },
		provisionUserOnEveryLogin: true,
		saml: {
			algorithms: { onDeprecated: "reject" },
			allowIdpInitiated: true,
			enableInResponseToValidation: true,
			requireTimestamps: true,
		},
	}),
	createRyuScimPlugin(),
	// SCIM may not create or rename an account to a platform-admin address.
	scimAdminEmailGuardPlugin(),
] satisfies NonNullable<BetterAuthOptions["plugins"]>;
