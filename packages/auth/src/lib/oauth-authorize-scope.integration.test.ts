import { beforeAll, describe, expect, it } from "bun:test";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import {
	OAUTH_OPT_IN_SCOPES,
	RYU_DEFAULT_OAUTH_SCOPES,
	RYU_SUPPORTED_SCOPES,
} from "../scopes.ts";
import { authorizeScopeDefaultsFromStore } from "./oauth-authorize-scope.ts";

// Runs `/oauth2/authorize` through Better Auth's real endpoint (memory
// adapter, the same `mcp()` scope options and the same before-hook default as
// `../index.ts`) to prove a request without `scope` never asks for
// `mail:manage`, whether it arrives as a GET query or a POST form body, and
// whatever scopes the client row holds.

const ORIGIN = "http://localhost:3000";
const REDIRECT_URI = "https://client.example.com/callback";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function createTestAuth(db: Record<string, unknown[]>) {
	return betterAuth({
		baseURL: ORIGIN,
		secret: "oauth-authorize-scope-integration-secret-2026",
		database: memoryAdapter(db),
		trustedOrigins: [ORIGIN],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/oauth2/authorize") {
					return;
				}
				const defaults = await authorizeScopeDefaultsFromStore(
					{ body: ctx.body, method: ctx.method, query: ctx.query },
					ctx.context.adapter
				);
				return defaults ? { context: defaults } : undefined;
			}),
		},
		plugins: [
			mcp({
				loginPage: `${ORIGIN}/login`,
				consentPage: `${ORIGIN}/oauth/consent`,
				resource: `${ORIGIN}/mcp`,
				scopes: RYU_SUPPORTED_SCOPES,
				clientRegistrationDefaultScopes: RYU_DEFAULT_OAUTH_SCOPES,
				clientRegistrationAllowedScopes: [...OAUTH_OPT_IN_SCOPES],
				advertisedMetadata: { scopes_supported: RYU_DEFAULT_OAUTH_SCOPES },
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				disableJwtPlugin: true,
			}),
		],
	});
}

// The memory adapter needs every table up front, and its transactions clone
// the store, so read the model names from a throwaway instance whose store
// creates tables on first use, then start the real one on a plain object.
async function memoryStore(): Promise<Record<string, unknown[]>> {
	const lazy = new Proxy<Record<string, unknown[]>>(
		{},
		{
			get: (target, model: string) => {
				target[model] ??= [];
				return target[model];
			},
		}
	);
	const { tables } = await createTestAuth(lazy).$context;
	return Object.fromEntries(
		Object.values(tables).map((table) => [table.modelName, []])
	);
}

const auth = createTestAuth(await memoryStore());

const CLIENTS = {
	// A client row that records no scopes (as a CIMD or admin row may).
	noScopes: null,
	// A row that lists mail:manage, as every DCR/CIMD row does.
	withManage: RYU_SUPPORTED_SCOPES,
} as const;

beforeAll(async () => {
	const { adapter } = await auth.$context;
	for (const [clientId, scopes] of Object.entries(CLIENTS)) {
		await adapter.create({
			model: "oauthClient",
			data: {
				clientId,
				disabled: false,
				// Skip-consent: a defaulted scope would be granted with no screen.
				skipConsent: true,
				public: true,
				tokenEndpointAuthMethod: "none",
				grantTypes: ["authorization_code"],
				responseTypes: ["code"],
				redirectUris: [REDIRECT_URI],
				...(scopes ? { scopes: [...scopes] } : {}),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
	}
});

function authorizeParameters(clientId: string, scope?: string) {
	const parameters = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		state: "state-1",
		code_challenge: CODE_CHALLENGE,
		code_challenge_method: "S256",
	});
	if (scope !== undefined) {
		parameters.set("scope", scope);
	}
	return parameters;
}

/** The scopes the unauthenticated authorize redirect carries to sign-in. */
async function requestedScopes(response: Response): Promise<string[]> {
	const location =
		response.headers.get("location") ??
		((await response.json()) as { url?: string }).url;
	if (!location) {
		throw new Error(`authorize did not redirect (${response.status})`);
	}
	const url = new URL(location);
	if (url.pathname !== "/login") {
		throw new Error(`authorize redirected to ${location}, not sign-in`);
	}
	return (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
}

function getAuthorize(parameters: URLSearchParams) {
	return auth.handler(
		new Request(`${ORIGIN}/api/auth/oauth2/authorize?${parameters}`)
	);
}

function postAuthorize(parameters: URLSearchParams) {
	return auth.handler(
		new Request(`${ORIGIN}/api/auth/oauth2/authorize`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: ORIGIN,
			},
			body: parameters.toString(),
		})
	);
}

describe("/oauth2/authorize without scope", () => {
	for (const [method, send] of [
		["GET", getAuthorize],
		["POST", postAuthorize],
	] as const) {
		for (const clientId of Object.keys(CLIENTS)) {
			it(`${method} for ${clientId} leaves out mail:manage`, async () => {
				const scopes = await requestedScopes(
					await send(authorizeParameters(clientId))
				);
				expect(scopes).toContain("mail:send");
				expect(scopes).not.toContain("mail:manage");
			});
		}

		it(`${method} asking for mail:manage by name keeps it`, async () => {
			const scopes = await requestedScopes(
				await send(authorizeParameters("withManage", "mail:read mail:manage"))
			);
			expect(scopes).toEqual(["mail:read", "mail:manage"]);
		});
	}
});

describe("a dynamically registered client", () => {
	it("is stored with mail:manage, which a request without scope still leaves out", async () => {
		const registration = await auth.handler(
			new Request(`${ORIGIN}/api/auth/oauth2/register`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({
					client_name: "DCR without scope",
					redirect_uris: [REDIRECT_URI],
					token_endpoint_auth_method: "none",
				}),
			})
		);
		if (registration.status >= 300) {
			throw new Error(await registration.text());
		}
		const client = (await registration.json()) as {
			client_id: string;
			scope?: string;
		};
		// Better Auth stores the default-plus-allowed union whatever the
		// registration asked for; the stored list grants nothing by itself.
		expect(client.scope?.split(" ")).toContain("mail:manage");
		for (const send of [getAuthorize, postAuthorize]) {
			const scopes = await requestedScopes(
				await send(authorizeParameters(client.client_id))
			);
			expect(scopes).toContain("mail:send");
			expect(scopes).not.toContain("mail:manage");
		}
	});
});

describe("protected-resource metadata", () => {
	it("advertises the default scopes, not opt-in ones", async () => {
		const response = await auth.handler(
			new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)
		);
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as { scopes_supported?: string[] };
		expect(metadata.scopes_supported).toContain("mail:send");
		expect(metadata.scopes_supported).not.toContain("mail:manage");
	});
});
