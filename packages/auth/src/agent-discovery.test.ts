import { expect, test } from "bun:test";
import { agentRegistrationMetadata } from "./agent-discovery.ts";

test("registration discovery describes OAuth consent and advertised revocation", () => {
	const metadata = agentRegistrationMetadata(
		{
			registration_endpoint: "https://api.example.com/api/auth/oauth2/register",
			authorization_endpoint:
				"https://api.example.com/api/auth/oauth2/authorize",
			revocation_endpoint: "https://api.example.com/api/auth/oauth2/revoke",
		},
		"https://example.com"
	);
	expect(metadata?.register_uri).toBe(
		"https://api.example.com/api/auth/oauth2/register"
	);
	expect(metadata?.claim_uri).toBe(
		"https://api.example.com/api/auth/oauth2/authorize"
	);
	expect(metadata?.anonymous.credential_types_supported).toEqual([
		"oauth2_access_token",
		"oauth2_refresh_token",
	]);
	expect(metadata?.revocation_uri).toBe(
		"https://api.example.com/api/auth/oauth2/revoke"
	);
	expect(metadata).not.toHaveProperty("identity_assertion");
	expect(metadata).not.toHaveProperty("events_supported");
});

test("does not invent a registration method when the issuer has none", () => {
	expect(agentRegistrationMetadata({}, "https://example.com")).toBeUndefined();
});
