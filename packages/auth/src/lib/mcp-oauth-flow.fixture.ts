import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";
import { z } from "zod";

// MCP OAuth through the shipping Better Auth instance, for the proofs that need
// tokens the real provider issued: `src/mcp-oauth-access-tokens.test.ts` here
// and `apps/server/src/hosted-mcp.provider-tokens.test.ts`. `auth` from
// ../index.ts runs with its `mcp()` provider (`storeTokens: "hashed"`), the
// encrypted Mongo adapter and every Ryu hook, against a real Mongo replica set.
// The Mongoose models load and build their indexes the way the server's boot
// does. Nothing in the sign-up, sign-in, authorization, token, refresh,
// userinfo or sign-out path is replaced. The two external systems the flow
// reaches stand in as fixtures: with USESEND_API_KEY unset the shipping mailer
// writes each email to the console, which is read as the inbox, and requests
// to Polar (customer sync) are refused. DPoP proofs (RFC 9449) are signed here
// with a real P-256 key, as a sender-constrained MCP client signs them.

const SERVER_ORIGIN = "http://localhost:3000";
const WEB_ORIGIN = "http://localhost:3001";
const REDIRECT_URI = "http://127.0.0.1:47813/oauth/callback";
const MCP_RESOURCE = `${SERVER_ORIGIN}/mcp`;
const TOKEN_URL = `${SERVER_ORIGIN}/api/auth/oauth2/token`;
const USERINFO_URL = `${SERVER_ORIGIN}/api/auth/oauth2/userinfo`;
const PASSWORD = "Correct-Horse-42!";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const sessionAnswer = z.object({
	session: z.object({ id: z.string().min(1) }),
	user: z.object({ email: z.string(), id: z.string().min(1) }),
});
const registeredClient = z.object({ client_id: z.string().min(1) });
const consentAnswer = z.union([
	z.object({ redirect_uri: z.string() }),
	z.object({ url: z.string() }),
]);
const tokenAnswer = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	token_type: z.string().optional(),
});
const errorAnswer = z.object({ error: z.string() });
const refusalAnswer = errorAnswer.extend({
	error_description: z.string().optional(),
});
const userinfoAnswer = z.object({ email: z.string(), sub: z.string() });
const publicEcJwk = z.object({
	crv: z.literal("P-256"),
	kty: z.literal("EC"),
	x: z.string(),
	y: z.string(),
});

/** A sender-constrained client's DPoP key (RFC 9449). */
export interface DpopKey {
	/** RFC 7638 SHA-256 thumbprint of the public key: the token's `cnf.jkt`. */
	jkt: string;
	privateKey: KeyObject;
	publicJwk: z.output<typeof publicEcJwk>;
}

/** A fresh P-256 DPoP key pair and its thumbprint. */
export function createDpopKey(): DpopKey {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	const publicJwk = publicEcJwk.parse(publicKey.export({ format: "jwk" }));
	// RFC 7638: the required members in lexicographic order, no whitespace.
	const thumbprintInput = JSON.stringify({
		crv: publicJwk.crv,
		kty: publicJwk.kty,
		x: publicJwk.x,
		y: publicJwk.y,
	});
	return {
		jkt: createHash("sha256").update(thumbprintInput).digest("base64url"),
		privateKey,
		publicJwk,
	};
}

export interface DpopProofClaims {
	/** The access token the proof travels with; its SHA-256 becomes `ath`. */
	accessToken?: string;
	htm: string;
	htu: string;
	/** Seconds since the epoch; now by default. */
	iat?: number;
	/** A fresh random id by default. */
	jti?: string;
}

/** An ES256-signed DPoP proof JWT (`typ: dpop+jwt`) for one HTTP request. */
export function dpopProof(key: DpopKey, claims: DpopProofClaims): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ alg: "ES256", jwk: key.publicJwk, typ: "dpop+jwt" });
	const payload = encode({
		...(claims.accessToken === undefined
			? {}
			: {
					ath: createHash("sha256")
						.update(claims.accessToken)
						.digest("base64url"),
				}),
		htm: claims.htm,
		htu: claims.htu,
		iat: claims.iat ?? Math.floor(Date.now() / 1000),
		jti: claims.jti ?? randomUUID(),
	});
	const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
		dsaEncoding: "ieee-p1363",
		key: key.privateKey,
	}).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

export interface McpOAuthFlowOptions {
	/** A database of the caller's own; the flow drops it on `close()`. */
	databaseUrl: string;
	/** The scope every authorization requests unless a call names its own. */
	scope?: string;
}

export interface McpTokenExchange {
	accessToken: string | null;
	/** Whether Ryu sent the browser to the consent page for this authorization. */
	consentShown: boolean;
	duplicateKeyErrors: string[];
	/** A refusal's `error_description` (or else its `error`). */
	error: string | null;
	refreshToken: string | null;
	status: number;
	/** `Bearer`, or `DPoP` for a token bound to the client's DPoP key. */
	tokenType: string | null;
}

export interface IssueAccessTokenOptions {
	/** Present a DPoP proof at the token endpoint, binding the token to this key. */
	dpopKey?: DpopKey;
	scope?: string;
}

/** An authorization code the client's redirect received, not yet redeemed. */
export interface AuthorizationCodeGrant {
	clientId: string;
	code: string;
	consentShown: boolean;
	/** The PKCE verifier of the authorization request. */
	verifier: string;
}

/**
 * A DPoP proof for a provider request: a key to sign a fresh proof with, or a
 * proof JWT presented as given.
 */
export type DpopPresentation = DpopKey | string;

/** One browser (one cookie jar, one Ryu session) in the MCP OAuth flow. */
export interface McpOAuthBrowser {
	/** Authorize (accepting consent when shown) without redeeming the code. */
	authorizeCode(
		clientId: string,
		options?: { scope?: string }
	): Promise<AuthorizationCodeGrant>;
	/** One request through the shipping Better Auth handler, as the browser sends it. */
	browser(
		path: string,
		init?: { body?: object; method?: "GET" | "POST" }
	): Promise<Response>;
	/** The browser's origin and cookies, for requests to other Ryu routes. */
	browserHeaders(): Headers;
	/** Authorize (accepting consent when shown) and redeem the code. */
	issueAccessToken(
		clientId: string,
		options?: IssueAccessTokenOptions
	): Promise<McpTokenExchange>;
	/** The id of this browser's Ryu session, as Better Auth reports it. */
	sessionId(): Promise<string>;
	/**
	 * Whether an authorization request would show the consent page, without
	 * answering it.
	 */
	showsConsent(
		clientId: string,
		options?: { prompt?: "consent"; scope?: string }
	): Promise<boolean>;
}

/** The signed-up user's browser plus the flow's client-side operations. */
export interface McpOAuthFlow extends McpOAuthBrowser {
	/** The database the shipping auth instance writes to. */
	client: typeof import("@ryu/db")["client"];
	/** Drop the database and disconnect. */
	close(): Promise<void>;
	mcpResource: string;
	/** Redeem an authorization code as the public client. */
	redeemCode(
		grant: AuthorizationCodeGrant,
		dpop?: DpopPresentation
	): Promise<McpTokenExchange>;
	/** Redeem a refresh token as the public client. */
	refreshAccessToken(
		clientId: string,
		refreshToken: string
	): Promise<{
		accessToken: string | null;
		error: string | null;
		refreshToken: string | null;
		status: number;
	}>;
	registerMcpClient(
		clientName?: string,
		options?: { grantTypes?: readonly string[] }
	): Promise<string>;
	serverOrigin: string;
	/** Sign the signed-up user in again from a second browser: a second session. */
	signIn(email: string): Promise<McpOAuthBrowser>;
	signUpAndVerify(email: string): Promise<{ email: string; id: string }>;
	/** The provider's token endpoint, the `htu` of a proof sent there. */
	tokenUrl: string;
	/**
	 * What the provider's userinfo endpoint answers for one access token: as a
	 * bearer token, or under the DPoP scheme with a proof.
	 */
	userinfo(
		accessToken: string,
		dpop?: DpopPresentation
	): Promise<{ email: string | null; status: number }>;
	/** The provider's userinfo endpoint, the `htu` of a proof sent there. */
	userinfoUrl: string;
}

/** Diagnostics go to stderr so a helper process's stdout stays its result. */
const write = (text: string) => process.stderr.write(`${text}\n`);

/** Setup steps fail loudly with the response that broke them. */
async function requireStatus(
	step: string,
	response: Response,
	status: number
): Promise<Response> {
	if (response.status !== status) {
		throw new Error(
			`${step}: expected HTTP ${status}, got ${response.status}: ${await response.text()}`
		);
	}
	return response;
}

/** A response body as JSON, or null when it is not JSON. */
function jsonOrNull(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

function pkcePair() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { challenge, verifier };
}

/**
 * Configure the environment, load the shipping auth instance against
 * `databaseUrl` and return one browser's view of the MCP OAuth flow.
 */
export async function startMcpOAuthFlow(
	options: McpOAuthFlowOptions
): Promise<McpOAuthFlow> {
	const defaultScope = options.scope ?? "openid profile email";
	Object.assign(process.env, {
		BETTER_AUTH_SECRET: `mcp-oauth-proof-${randomBytes(24).toString("hex")}`,
		BETTER_AUTH_URL: SERVER_ORIGIN,
		DATABASE_URL: options.databaseUrl,
		FRONTEND_URL: WEB_ORIGIN,
		POLAR_ACCESS_TOKEN: "mcp-oauth-proof",
		POLAR_SUCCESS_URL: `${WEB_ORIGIN}/success`,
		RYU_DB_MASTER_KEY: randomBytes(32).toString("base64"),
		WAITLIST_ENABLED: "false",
	});
	for (const name of [
		"ADMIN_EMAILS",
		"TURNSTILE_SECRET_KEY",
		"USESEND_API_KEY",
	]) {
		delete process.env[name];
	}

	// The console mailer's output is the inbox; duplicate-key failures the
	// handler logs are kept so a refused exchange reports its cause.
	const mailbox: string[] = [];
	const duplicateKeyLog: string[] = [];
	console.warn = (...parts: unknown[]) => {
		const text = parts.map(String).join(" ");
		if (text.includes("EMAIL (not sent")) {
			mailbox.push(text);
			return;
		}
		write(text);
	};
	console.error = (...parts: unknown[]) => {
		const text = parts
			.map((part) => (part instanceof Error ? part.message : String(part)))
			.join(" ");
		if (text.includes("E11000")) {
			duplicateKeyLog.push(text);
		}
		write(text);
	};

	// Refuse every non-loopback request, as the web-auth stack's server preload
	// does, so the proof never calls a live third party. The only one this flow
	// reaches is Polar's customer sync, whose shipping hook treats the failure as
	// non-critical.
	const nativeFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (LOOPBACK.has(url.hostname)) {
				return nativeFetch(input, init);
			}
			return Promise.reject(new Error(`proof refused egress to ${url.host}`));
		},
		{ preconnect: nativeFetch.preconnect }
	);

	const { auth } = await import("../index.ts");
	const { client } = await import("@ryu/db");
	// The Mongoose instance the shipping models (and the server's boot) use.
	const { base: models } = (await import("@ryu/db/models/auth.model"))
		.OAuthAccessToken;
	// The server boot settles every loaded model's automatic index build before
	// it serves (`settleModelIndexBuilds`); do the same for the models the
	// shipping auth instance loaded, so each collection carries exactly the
	// indexes a booted server gives it.
	await Promise.allSettled(
		models.modelNames().map((name) => models.model(name).init())
	);

	/**
	 * apps/server mounts this handler through `handleAuthRequest`, which replays
	 * a request once when Better Auth answers 5xx: on a fresh database Mongo
	 * aborts the first transactional write to a collection whose indexes are
	 * still being created. Mount it the same way.
	 */
	async function serve(request: Request): Promise<Response> {
		const replay = request.clone();
		const response = await auth.handler(request);
		if (response.status < 500) {
			return response;
		}
		write(
			`replayed ${request.method} ${new URL(request.url).pathname} after ${response.status}`
		);
		await Bun.sleep(100);
		return auth.handler(replay);
	}

	async function verificationLink(email: string): Promise<URL> {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const message = mailbox.find(
				(text) =>
					text.includes(`To:      ${email}`) && text.includes("official")
			);
			const link = message?.match(
				/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/u
			)?.[0];
			if (link) {
				return new URL(link);
			}
			await Bun.sleep(50);
		}
		throw new Error(`no verification email reached ${email}`);
	}

	/** Redeem a code (or a refresh token) at the token endpoint as the public client. */
	async function tokenRequest(
		form: Record<string, string>,
		dpop?: DpopPresentation
	): Promise<Response> {
		const headers = new Headers({
			"content-type": "application/x-www-form-urlencoded",
		});
		if (dpop) {
			headers.set(
				"dpop",
				typeof dpop === "string"
					? dpop
					: dpopProof(dpop, { htm: "POST", htu: TOKEN_URL })
			);
		}
		return await serve(
			new Request(TOKEN_URL, {
				body: new URLSearchParams(form),
				headers,
				method: "POST",
			})
		);
	}

	/**
	 * Redeem a code as the public client: no cookies, only the code, its PKCE
	 * verifier and, for a sender-constrained client, a DPoP proof. A refusal
	 * carries its logged cause.
	 */
	async function redeemCode(
		grant: AuthorizationCodeGrant,
		dpop?: DpopPresentation
	): Promise<McpTokenExchange> {
		const logged = duplicateKeyLog.length;
		const response = await tokenRequest(
			{
				client_id: grant.clientId,
				code: grant.code,
				code_verifier: grant.verifier,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				resource: MCP_RESOURCE,
			},
			dpop
		);
		const body = await response.text();
		const answer =
			response.status === 200 ? tokenAnswer.parse(JSON.parse(body)) : null;
		const refusal =
			response.status === 200
				? undefined
				: refusalAnswer.safeParse(jsonOrNull(body)).data;
		return {
			accessToken: answer?.access_token ?? null,
			consentShown: grant.consentShown,
			duplicateKeyErrors: duplicateKeyLog.slice(logged),
			error: refusal ? (refusal.error_description ?? refusal.error) : null,
			refreshToken: answer?.refresh_token ?? null,
			status: response.status,
			tokenType: answer?.token_type ?? null,
		};
	}

	/** A browser with its own cookie jar. */
	function createBrowser(): McpOAuthBrowser {
		const cookies = new Map<string, string>();

		function remember(response: Response): Response {
			for (const header of response.headers.getSetCookie()) {
				const [pair = ""] = header.split(";");
				const separator = pair.indexOf("=");
				const name = pair.slice(0, separator).trim();
				const value = pair.slice(separator + 1).trim();
				if (/max-age=0/iu.test(header) || value === "") {
					cookies.delete(name);
				} else {
					cookies.set(name, value);
				}
			}
			return response;
		}

		function browserHeaders(): Headers {
			const headers = new Headers({ origin: WEB_ORIGIN });
			if (cookies.size > 0) {
				headers.set(
					"cookie",
					[...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
				);
			}
			return headers;
		}

		async function browser(
			path: string,
			init: { body?: object; method?: "GET" | "POST" } = {}
		): Promise<Response> {
			const headers = browserHeaders();
			if (init.body) {
				headers.set("content-type", "application/json");
			}
			return remember(
				await serve(
					new Request(new URL(path, SERVER_ORIGIN), {
						body: init.body ? JSON.stringify(init.body) : undefined,
						headers,
						method: init.method ?? "GET",
					})
				)
			);
		}

		/** Where the authorization endpoint sends this browser first. */
		async function authorize(
			clientId: string,
			challenge: string,
			state: string,
			authorization: { prompt?: "consent"; scope?: string }
		): Promise<URL> {
			const query = new URLSearchParams({
				client_id: clientId,
				code_challenge: challenge,
				code_challenge_method: "S256",
				redirect_uri: REDIRECT_URI,
				resource: MCP_RESOURCE,
				response_type: "code",
				scope: authorization.scope ?? defaultScope,
				state,
			});
			if (authorization.prompt) {
				query.set("prompt", authorization.prompt);
			}
			const response = await requireStatus(
				"authorize",
				await browser(`/api/auth/oauth2/authorize?${query}`),
				302
			);
			return new URL(response.headers.get("location") ?? "");
		}

		const isConsentPage = (url: URL) =>
			`${url.origin}${url.pathname}` === `${WEB_ORIGIN}/oauth/consent`;

		async function showsConsent(
			clientId: string,
			authorization: { prompt?: "consent"; scope?: string } = {}
		): Promise<boolean> {
			return isConsentPage(
				await authorize(
					clientId,
					pkcePair().challenge,
					randomUUID(),
					authorization
				)
			);
		}

		/**
		 * Authorize as the signed-in user (accepting the consent page when it is
		 * shown) and return the authorization code the client's redirect receives.
		 */
		async function authorizationCode(
			clientId: string,
			challenge: string,
			scope: string | undefined
		): Promise<{ code: string; consentShown: boolean }> {
			const state = randomUUID();
			let redirect = await authorize(clientId, challenge, state, { scope });
			const consentShown = isConsentPage(redirect);
			if (consentShown) {
				// The shipping consent page posts its signed query back on Accept.
				const consent = await requireStatus(
					"consent",
					await browser("/api/auth/oauth2/consent", {
						body: { accept: true, oauth_query: redirect.search.slice(1) },
						method: "POST",
					}),
					200
				);
				const answer = consentAnswer.parse(await consent.json());
				redirect = new URL(
					"redirect_uri" in answer ? answer.redirect_uri : answer.url
				);
			}
			const code = redirect.searchParams.get("code");
			if (
				`${redirect.origin}${redirect.pathname}` !== REDIRECT_URI ||
				redirect.searchParams.get("state") !== state ||
				!code
			) {
				throw new Error(
					`authorization did not return a code: ${redirect.href}`
				);
			}
			return { code, consentShown };
		}

		/** Authorize with a fresh PKCE pair, without redeeming the code. */
		async function authorizeCode(
			clientId: string,
			options: { scope?: string } = {}
		): Promise<AuthorizationCodeGrant> {
			const pkce = pkcePair();
			const { code, consentShown } = await authorizationCode(
				clientId,
				pkce.challenge,
				options.scope
			);
			return { clientId, code, consentShown, verifier: pkce.verifier };
		}

		/** Authorize again and redeem the code as the public client. */
		async function issueAccessToken(
			clientId: string,
			issue: IssueAccessTokenOptions = {}
		): Promise<McpTokenExchange> {
			return await redeemCode(
				await authorizeCode(clientId, { scope: issue.scope }),
				issue.dpopKey
			);
		}

		async function sessionId(): Promise<string> {
			const session = await requireStatus(
				"session",
				await browser("/api/auth/get-session"),
				200
			);
			return sessionAnswer.parse(await session.json()).session.id;
		}

		return {
			authorizeCode,
			browser,
			browserHeaders,
			issueAccessToken,
			sessionId,
			showsConsent,
		};
	}

	const primary = createBrowser();

	/**
	 * Sign up with a password and open the emailed link, which signs the user
	 * in. Returns the user the resulting session belongs to.
	 */
	async function signUpAndVerify(
		email: string
	): Promise<{ email: string; id: string }> {
		await requireStatus(
			"age eligibility",
			await primary.browser("/api/auth/age-eligibility", {
				body: { dateOfBirth: "1990-04-12", acceptedTerms: true },
				method: "POST",
			}),
			200
		);
		await requireStatus(
			"sign-up",
			await primary.browser("/api/auth/sign-up/email", {
				body: { email, name: "Mona Mcp", password: PASSWORD },
				method: "POST",
			}),
			200
		);
		const link = await verificationLink(email);
		await requireStatus(
			"email verification",
			await primary.browser(`${link.pathname}${link.search}`),
			302
		);
		const session = await requireStatus(
			"session",
			await primary.browser("/api/auth/get-session"),
			200
		);
		return sessionAnswer.parse(await session.json()).user;
	}

	/** The sign-in code the console mailer sent to `email` after `sent` messages. */
	async function signInCode(email: string, sent: number): Promise<string> {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const code = mailbox
				.slice(sent)
				.find((text) => text.includes(`To:      ${email}`))
				?.match(/Your sign-in code is (\d+)/u)?.[1];
			if (code) {
				return code;
			}
			await Bun.sleep(50);
		}
		throw new Error(`no sign-in code reached ${email}`);
	}

	/**
	 * Sign in with the password from a new browser. Ryu asks an unknown device
	 * for a second factor; this account's is the emailed sign-in code.
	 */
	async function signIn(email: string): Promise<McpOAuthBrowser> {
		const other = createBrowser();
		await requireStatus(
			"sign-in",
			await other.browser("/api/auth/sign-in/email", {
				body: { email, password: PASSWORD },
				method: "POST",
			}),
			200
		);
		const sent = mailbox.length;
		await requireStatus(
			"sign-in code",
			await other.browser("/api/auth/email-otp/send-verification-otp", {
				body: { email, type: "sign-in" },
				method: "POST",
			}),
			200
		);
		await requireStatus(
			"second factor",
			await other.browser("/api/auth/sign-in/email-otp", {
				body: { email, otp: await signInCode(email, sent) },
				method: "POST",
			}),
			200
		);
		return other;
	}

	async function registerMcpClient(
		clientName = "Proof MCP client",
		registration: { grantTypes?: readonly string[] } = {}
	): Promise<string> {
		const response = await requireStatus(
			"client registration",
			await serve(
				new Request(`${SERVER_ORIGIN}/api/auth/oauth2/register`, {
					body: JSON.stringify({
						application_type: "native",
						client_name: clientName,
						grant_types: registration.grantTypes ?? ["authorization_code"],
						redirect_uris: [REDIRECT_URI],
						response_types: ["code"],
						token_endpoint_auth_method: "none",
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				})
			),
			// RFC 7591: a registered client is answered with 201 Created.
			201
		);
		return registeredClient.parse(await response.json()).client_id;
	}

	async function refreshAccessToken(clientId: string, refreshToken: string) {
		const response = await tokenRequest({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: MCP_RESOURCE,
		});
		const body: unknown = JSON.parse(await response.text());
		const answer =
			response.status === 200 ? tokenAnswer.parse(body) : undefined;
		return {
			accessToken: answer?.access_token ?? null,
			error: errorAnswer.safeParse(body).data?.error ?? null,
			refreshToken: answer?.refresh_token ?? null,
			status: response.status,
		};
	}

	async function userinfo(accessToken: string, dpop?: DpopPresentation) {
		const headers = new Headers({
			authorization: `${dpop ? "DPoP" : "Bearer"} ${accessToken}`,
		});
		if (dpop) {
			headers.set(
				"dpop",
				typeof dpop === "string"
					? dpop
					: dpopProof(dpop, { accessToken, htm: "GET", htu: USERINFO_URL })
			);
		}
		const response = await serve(new Request(USERINFO_URL, { headers }));
		return response.status === 200
			? {
					email: userinfoAnswer.parse(await response.json()).email,
					status: 200,
				}
			: { email: null, status: response.status };
	}

	return {
		...primary,
		client,
		async close() {
			await client.dropDatabase().catch(() => undefined);
			await models.disconnect();
		},
		mcpResource: MCP_RESOURCE,
		redeemCode,
		refreshAccessToken,
		registerMcpClient,
		serverOrigin: SERVER_ORIGIN,
		signIn,
		signUpAndVerify,
		tokenUrl: TOKEN_URL,
		userinfo,
		userinfoUrl: USERINFO_URL,
	};
}
