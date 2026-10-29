import { z } from "zod";

const registrationMetadataSchema = z.preprocess(
	(value) => value,
	z.object({
		registration_endpoint: z.string(),
		authorization_endpoint: z.string(),
		revocation_endpoint: z.string().optional().catch(undefined),
	})
);

export interface RegistrationDiscovery {
	anonymous: { credential_types_supported: string[] };
	claim_flows_supported: string[];
	claim_uri: string;
	identity_types_supported: string[];
	register_uri: string;
	revocation_uri?: string;
	skill: string;
}

/** Registration discovery for Ryu's existing OAuth client and consent flow. */
export function agentRegistrationMetadata(
	metadata: z.input<typeof registrationMetadataSchema>,
	siteOrigin: string
): RegistrationDiscovery | undefined {
	const parsed = registrationMetadataSchema.safeParse(metadata);
	if (!parsed.success) {
		return undefined;
	}
	const registration: RegistrationDiscovery = {
		skill: new URL("/auth.md", siteOrigin).href,
		register_uri: parsed.data.registration_endpoint,
		identity_types_supported: ["anonymous"],
		anonymous: {
			credential_types_supported: [
				"oauth2_access_token",
				"oauth2_refresh_token",
			],
		},
		claim_uri: parsed.data.authorization_endpoint,
		claim_flows_supported: ["authorization_code"],
	};
	if (parsed.data.revocation_endpoint !== undefined) {
		registration.revocation_uri = parsed.data.revocation_endpoint;
	}
	return registration;
}
