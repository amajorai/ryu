import { describe, expect, it } from "bun:test";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { expoWithoutSessionHandoff } from "./expo-session-handoff.ts";

/**
 * A magic link anyone can request for any address must never redirect the
 * victim's session cookie into a `ryu://` URL, which any installed app can
 * claim. The stock `expo()` plugin is the control: it proves the fixture
 * reaches the handoff path that the Ryu wrapper removes.
 */

const BASE_URL = "http://localhost:3000";
const SECRET = "expo-session-handoff-test-secret-at-least-32-chars";
const EMAIL = "victim@example.com";

async function verifyRedirect(
	plugin: ReturnType<typeof expo>,
	callbackURL: string
): Promise<{
	location: string;
	requestStatus: number;
	setCookie: string | null;
	verifyStatus: number;
}> {
	const database = { account: [], session: [], user: [], verification: [] };
	let link = "";
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter(database),
		plugins: [
			magicLink({
				sendMagicLink: ({ url }) => {
					link = url;
				},
			}),
			plugin,
		],
		secret: SECRET,
		trustedOrigins: ["ryu://"],
	});
	const requested = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
			body: JSON.stringify({ callbackURL, email: EMAIL }),
			headers: { "content-type": "application/json", origin: BASE_URL },
			method: "POST",
		})
	);
	if (!link) {
		throw new Error(`magic link was not sent (status ${requested.status})`);
	}
	const verified = await auth.handler(new Request(link));
	return {
		location: verified.headers.get("location") ?? "",
		requestStatus: requested.status,
		setCookie: verified.headers.get("set-cookie"),
		verifyStatus: verified.status,
	};
}

describe("expo session handoff", () => {
	it("stock expo() appends the session cookie to a ryu:// redirect", async () => {
		const { location, verifyStatus } = await verifyRedirect(
			expo(),
			"ryu://evil/path"
		);
		expect(verifyStatus).toBe(302);
		expect(new URL(location).searchParams.get("cookie")).toContain(
			"session_token"
		);
	});

	it("redirects to ryu:// without the session cookie", async () => {
		const { location, requestStatus, setCookie, verifyStatus } =
			await verifyRedirect(expoWithoutSessionHandoff(), "ryu://evil/path");
		expect(requestStatus).toBe(200);
		expect(verifyStatus).toBe(302);
		const redirect = new URL(location);
		expect(redirect.protocol).toBe("ryu:");
		expect(redirect.searchParams.has("cookie")).toBe(false);
		expect(location).not.toContain("session_token");
		// The browser that opened the link still gets its own session.
		expect(setCookie).toContain("session_token");
	});

	it("keeps the expo-origin request rewrite and the authorization proxy", () => {
		const plugin = expoWithoutSessionHandoff();
		expect(plugin.id).toBe("expo");
		expect(typeof plugin.onRequest).toBe("function");
		expect(Object.keys(plugin.endpoints ?? {})).toContain(
			"expoAuthorizationProxy"
		);
	});
});
