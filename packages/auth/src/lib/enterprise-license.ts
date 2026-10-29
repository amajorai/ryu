import { createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";
import {
	ENTERPRISE_CAPABILITIES,
	type EnterpriseCapability,
	normalizeEnterpriseCapabilities,
} from "./enterprise-entitlement-policy.ts";

const MAX_LICENSE_LENGTH = 64 * 1024;
const LICENSE_AUDIENCE = "ryu-enterprise";

export interface SelfHostedEnterpriseLicense {
	capabilities: EnterpriseCapability[];
	expiresAt: Date | null;
	issuedAt: Date | null;
	licenseId: string | null;
	organizationId: string;
	plan: "enterprise" | "enterprise-plus" | "dedicated";
}

const headerSchema = z.object({
	alg: z.literal("RS256"),
});
const payloadSchema = z.object({
	organizationId: z.string().min(1),
	plan: z.enum(["enterprise", "enterprise-plus", "dedicated"]),
	aud: z.literal(LICENSE_AUDIENCE).optional(),
	iss: z.literal("ryu").optional(),
	iat: z.number().optional(),
	exp: z.number().optional(),
	nbf: z.number().optional(),
	capabilities: z.preprocess(
		(value) => normalizeEnterpriseCapabilities(value),
		z.array(z.enum(ENTERPRISE_CAPABILITIES))
	),
	licenseId: z.string().nullable().catch(null),
});
function decodeJson<S extends z.ZodType>(
	value: string,
	schema: S
): z.output<S> | null {
	try {
		const parsed = schema.safeParse(
			JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
function unixDate(value: number | undefined): Date | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	const date = new Date(value * 1000);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Verify a vendor-signed self-host Enterprise license without network access. */
export function verifySelfHostedEnterpriseLicense(
	token: string | undefined,
	publicKey: string | undefined,
	now = new Date()
): SelfHostedEnterpriseLicense | null {
	if (!(token && publicKey) || token.length > MAX_LICENSE_LENGTH) {
		return null;
	}

	const parts = token.split(".");
	if (parts.length !== 3) {
		return null;
	}
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	if (!(encodedHeader && encodedPayload && encodedSignature)) {
		return null;
	}
	const header = decodeJson(encodedHeader, headerSchema);
	const payload = decodeJson(encodedPayload, payloadSchema);
	if (!(header && payload)) {
		return null;
	}
	const { organizationId, plan } = payload;

	const issuedAt = unixDate(payload.iat);
	const expiresAt = unixDate(payload.exp);
	const notBefore = unixDate(payload.nbf);
	if (
		(payload.iat !== undefined && issuedAt === null) ||
		(payload.exp !== undefined && expiresAt === null) ||
		(payload.nbf !== undefined && notBefore === null)
	) {
		return null;
	}
	if (expiresAt && expiresAt.getTime() <= now.getTime()) {
		return null;
	}
	if (notBefore && notBefore.getTime() > now.getTime()) {
		return null;
	}

	const capabilities = normalizeEnterpriseCapabilities(payload.capabilities);
	if (capabilities.length === 0) {
		return null;
	}

	try {
		const key = createPublicKey({
			key: publicKey.replaceAll("\\n", "\n"),
			format: "pem",
			type: "spki",
		});
		const valid = verifySignature(
			"RSA-SHA256",
			Buffer.from(`${encodedHeader}.${encodedPayload}`),
			key,
			Buffer.from(encodedSignature, "base64url")
		);
		if (!valid) {
			return null;
		}
	} catch {
		return null;
	}

	return {
		capabilities,
		expiresAt: expiresAt ?? null,
		issuedAt: issuedAt ?? null,
		licenseId: payload.licenseId,
		organizationId,
		plan,
	};
}
