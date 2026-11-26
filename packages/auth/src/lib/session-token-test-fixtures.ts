import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { AuthTokenAtRest } from "./auth-token-at-rest.ts";
import { rejectNativeSessionListOverHttp } from "./native-session-list-guard.ts";
import { sessionCookieCache } from "./session-cache.ts";
import { wrapSsoProviderAdapter } from "./sso-provider-encryption.ts";

/**
 * A real Better Auth on the in-memory store behind the production at-rest
 * adapter wrapper (session tokens stored as digests), with the bearer plugin
 * and the production cookie cache. Test-only.
 */

export const BASE_URL = "http://localhost:3000";
export const SECRET = "session-token-test-secret-at-least-32-characters";
const PASSWORD = "correct horse battery staple";
const EMAIL = "owner@example.com";

type Row = Record<string, unknown>;

export function sessionTokenFixture({ guarded = true } = {}) {
	const database: Record<
		"account" | "session" | "user" | "verification",
		Row[]
	> = { account: [], session: [], user: [], verification: [] };
	const store = memoryAdapter(database);
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: (options) =>
			wrapSsoProviderAdapter(store(options), new AuthTokenAtRest(SECRET)),
		emailAndPassword: { enabled: true },
		hooks: guarded
			? {
					before: createAuthMiddleware(async (ctx) => {
						await Promise.resolve();
						rejectNativeSessionListOverHttp(ctx);
					}),
				}
			: {},
		plugins: [bearer()],
		secret: SECRET,
		session: { cookieCache: sessionCookieCache },
	});
	return { auth, database };
}

export type SessionTokenFixture = ReturnType<typeof sessionTokenFixture>;

/** One signed-in device: its bearer, its cookies and its raw session token. */
export interface SignedIn {
	readonly bearer: Headers;
	readonly cookies: Headers;
	readonly token: string;
}

function signedIn(response: Response): SignedIn {
	const signed = response.headers.get("set-auth-token");
	if (!signed) {
		throw new Error(`no session token (${response.status})`);
	}
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	return {
		bearer: new Headers({ authorization: `Bearer ${signed}` }),
		cookies: new Headers({ cookie, origin: BASE_URL }),
		token: decodeURIComponent(signed).split(".")[0] ?? "",
	};
}

/** Create the account; its first session. */
export async function signUp({ auth }: SessionTokenFixture): Promise<SignedIn> {
	return signedIn(
		await auth.api.signUpEmail({
			asResponse: true,
			body: { email: EMAIL, name: "Owner", password: PASSWORD },
		})
	);
}

/** Another session of the same account (a second device). */
export async function signIn({ auth }: SessionTokenFixture): Promise<SignedIn> {
	return signedIn(
		await auth.api.signInEmail({
			asResponse: true,
			body: { email: EMAIL, password: PASSWORD },
		})
	);
}
