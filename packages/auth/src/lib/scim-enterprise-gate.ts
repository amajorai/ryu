import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Live Enterprise entitlement gate for SCIM v2 protocol traffic.
 *
 * Better Auth authenticates a managed SCIM bearer and then provisions users and
 * groups without any Ryu callback, so the hosted auth route runs this first:
 * it authenticates the managed credential far enough to recover its tenant
 * (`provisioningDomainId`, which Ryu sets to the organization id) and refuses
 * the request while that organization lacks `enterprise.scim`. Suspension and
 * expiry therefore stop provisioning immediately, without waiting for the
 * connection to be decommissioned.
 *
 * The credential check mirrors `@better-auth/scim`'s managed tokens:
 * `ba_scim_credential_<id>.<secret>`, stored as an HMAC-SHA256 base64url
 * (unpadded) digest keyed by the managed `credentialHashSecret`, with
 * `hashVersion` "v1". `scim-enterprise-gate.integration.test.ts` checks this
 * against credentials issued by the installed plugin, so a plugin change to
 * the token or digest format fails that test instead of locking out every
 * SCIM client in production.
 */

export interface ScimManagedCredentialRecord {
	connectionRecordId: unknown;
	expiresAt: Date;
	hashVersion: string;
	status: string;
	tokenDigest: string;
}

export interface ScimManagedConnectionRecord {
	provisioningDomainId: string;
	status: string;
}

export interface ScimEnterpriseGateDependencies {
	credentialHashSecret: string;
	findConnection(
		recordId: unknown
	): Promise<ScimManagedConnectionRecord | null>;
	findCredential(
		credentialId: string
	): Promise<ScimManagedCredentialRecord | null>;
	hasEnterpriseScim(organizationId: string): Promise<boolean>;
}

export const SCIM_MANAGED_HASH_VERSION = "v1";
const MANAGED_TOKEN_PREFIX = "ba_scim_credential_";
const MANAGED_TOKEN = /^(ba_scim_credential_[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const SCIM_PATH_PREFIX = "/api/auth/scim/v2";

function scimError(
	status: 401 | 403 | 503,
	detail: string,
	wwwAuthenticate = false
): Response {
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Content-Type": "application/scim+json",
	});
	if (wwwAuthenticate) {
		headers.set("WWW-Authenticate", 'Bearer realm="SCIM"');
	}
	return new Response(
		JSON.stringify({
			detail,
			schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
			status: String(status),
		}),
		{ headers, status }
	);
}

/** The managed-credential digest `@better-auth/scim` stores for a token. */
export function scimManagedTokenDigest(secret: string, token: string): string {
	return createHmac("sha256", secret).update(token).digest("base64url");
}

function validDigest(secret: string, token: string, expected: string): boolean {
	const actualBytes = Buffer.from(scimManagedTokenDigest(secret, token));
	const expectedBytes = Buffer.from(expected);
	return (
		actualBytes.length === expectedBytes.length &&
		timingSafeEqual(actualBytes, expectedBytes)
	);
}

function isScimPath(pathname: string): boolean {
	return (
		pathname === SCIM_PATH_PREFIX || pathname.startsWith(`${SCIM_PATH_PREFIX}/`)
	);
}

/**
 * Authenticate a managed SCIM credential far enough to recover its tenant,
 * then enforce live Enterprise access before Better Auth handles the request.
 * Returns the refusal to send, or null to let Better Auth continue.
 *
 * Every auth request that carries a managed SCIM bearer is checked, not only
 * the exact SCIM prefix, so a path spelling that Better Auth might route
 * differently cannot skip the gate.
 */
export async function enforceScimEnterpriseAccess(
	request: Request,
	dependencies: ScimEnterpriseGateDependencies,
	now = new Date()
): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	const authorization = request.headers.get("authorization") ?? "";
	const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
	const managedBearer = bearer?.startsWith(MANAGED_TOKEN_PREFIX) ?? false;
	if (!(isScimPath(pathname) || managedBearer)) {
		return null;
	}
	if (!bearer) {
		// Better Auth answers an unauthenticated SCIM request itself.
		return null;
	}
	const credentialId = MANAGED_TOKEN.exec(bearer)?.[1];
	if (!credentialId) {
		return scimError(401, "Invalid SCIM bearer credential.", true);
	}
	try {
		const credential = await dependencies.findCredential(credentialId);
		if (
			credential?.hashVersion !== SCIM_MANAGED_HASH_VERSION ||
			credential.status !== "active" ||
			credential.expiresAt.getTime() <= now.getTime() ||
			!validDigest(
				dependencies.credentialHashSecret,
				bearer,
				credential.tokenDigest
			)
		) {
			return scimError(401, "Invalid SCIM bearer credential.", true);
		}
		const connection = await dependencies.findConnection(
			credential.connectionRecordId
		);
		const organizationId = connection?.provisioningDomainId.trim() ?? "";
		if (connection?.status !== "active" || !organizationId) {
			return scimError(401, "Invalid SCIM bearer credential.", true);
		}
		if (!(await dependencies.hasEnterpriseScim(organizationId))) {
			return scimError(
				403,
				"This organization's Enterprise SCIM access is inactive."
			);
		}
		return null;
	} catch {
		return scimError(503, "SCIM authorization is temporarily unavailable.");
	}
}
