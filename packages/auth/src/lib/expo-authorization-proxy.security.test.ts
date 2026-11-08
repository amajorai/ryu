import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { expoWithoutSessionHandoff } from "./expo-session-handoff.ts";

/**
 * GHSA-4wq4-2ppv-q3hg / CVE-2026-121802: `/expo-authorization-proxy` must not
 * mint a signed `state` cookie from attacker-controlled input without a live
 * Better Auth OAuth state verification row.
 */

const BASE_URL = "http://localhost:3000";
const SECRET =
	"expo-authorization-proxy-security-test-secret-at-least-32-chars";

function authWithExpo() {
	return betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter({
			account: [],
			session: [],
			user: [],
			verification: [],
		}),
		plugins: [expoWithoutSessionHandoff()],
		secret: SECRET,
		socialProviders: {
			google: {
				clientId: "test-google-client",
				clientSecret: "test-google-secret",
			},
		},
	});
}

describe("expo authorization proxy (GHSA-4wq4-2ppv-q3hg)", () => {
	it("does not set a signed state cookie when OAuth state was never issued", async () => {
		const auth = authWithExpo();
		const authorizationURL =
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=attacker-controlled-state&redirect_uri=https%3A%2F%2Fexample.com";
		const proxyUrl = new URL(`${BASE_URL}/api/auth/expo-authorization-proxy`);
		proxyUrl.searchParams.set("authorizationURL", authorizationURL);

		const response = await auth.handler(new Request(proxyUrl));

		expect(response.status).toBeGreaterThanOrEqual(300);
		expect(response.status).toBeLessThan(400);
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie.toLowerCase()).not.toContain("state=");
	});

	it("stores caller oauthState only in the oauth_state cookie, not the signed state cookie", async () => {
		const auth = authWithExpo();
		const authorizationURL =
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=legit-provider-state&redirect_uri=https%3A%2F%2Fexample.com";
		const proxyUrl = new URL(`${BASE_URL}/api/auth/expo-authorization-proxy`);
		proxyUrl.searchParams.set("authorizationURL", authorizationURL);
		proxyUrl.searchParams.set("oauthState", "forged-oauth-state");

		const response = await auth.handler(new Request(proxyUrl));

		expect(response.status).toBeGreaterThanOrEqual(300);
		expect(response.status).toBeLessThan(400);
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("better-auth.oauth_state=forged-oauth-state");
		expect(setCookie.toLowerCase()).not.toMatch(/\bstate=forged-oauth-state/i);
		expect(setCookie.toLowerCase()).not.toContain("better-auth.state=");
	});
});
