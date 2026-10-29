import { describe, expect, it } from "bun:test";
import { RYU_DEFAULT_OAUTH_SCOPES } from "../scopes.ts";
import {
	authorizeScopeDefaults,
	registeredClientScopes,
	scopeForAuthorizeWithoutScope,
} from "./oauth-authorize-scope.ts";

describe("scopeForAuthorizeWithoutScope", () => {
	const lookups: string[] = [];
	const clients: Record<string, readonly string[] | null> = {
		"explicit-manage": ["openid", "mail:read", "mail:send", "mail:manage"],
		"no-scopes": null,
	};
	const find = async (clientId: string) => {
		lookups.push(clientId);
		return clients[clientId] ?? null;
	};

	it("leaves the client's registered scopes, without mail:manage", async () => {
		expect(
			await scopeForAuthorizeWithoutScope(
				{ client_id: "explicit-manage", response_type: "code" },
				find
			)
		).toBe("openid mail:read mail:send");
	});

	it("uses the default scopes for a client with none on record", async () => {
		const scope = await scopeForAuthorizeWithoutScope(
			{ client_id: "no-scopes" },
			find
		);
		expect(scope).toBe(RYU_DEFAULT_OAUTH_SCOPES.join(" "));
		expect(scope?.split(" ")).not.toContain("mail:manage");
	});

	it("never touches a request that names a scope, even an empty one", async () => {
		lookups.length = 0;
		for (const scope of ["mail:manage", "", "openid"]) {
			expect(
				await scopeForAuthorizeWithoutScope(
					{ client_id: "explicit-manage", scope },
					find
				)
			).toBeNull();
		}
		expect(lookups).toEqual([]);
	});

	it("leaves pushed requests and requests without a client to Better Auth", async () => {
		lookups.length = 0;
		expect(
			await scopeForAuthorizeWithoutScope(
				{ client_id: "explicit-manage", request_uri: "urn:par:1" },
				find
			)
		).toBeNull();
		expect(await scopeForAuthorizeWithoutScope({}, find)).toBeNull();
		expect(await scopeForAuthorizeWithoutScope(undefined, find)).toBeNull();
		expect(lookups).toEqual([]);
	});
});

describe("authorizeScopeDefaults", () => {
	const find = async () => ["openid", "mail:send", "mail:manage"] as const;

	it("defaults a GET query", async () => {
		expect(
			await authorizeScopeDefaults(
				{ method: "GET", query: { client_id: "c", state: "s" } },
				find
			)
		).toEqual({
			query: { client_id: "c", state: "s", scope: "openid mail:send" },
		});
	});

	it("defaults a POST form body, which is what Better Auth reads", async () => {
		expect(
			await authorizeScopeDefaults(
				{
					method: "POST",
					query: { disableCookieCache: true },
					body: { client_id: "c", response_type: "code" },
				},
				find
			)
		).toEqual({
			body: {
				client_id: "c",
				response_type: "code",
				scope: "openid mail:send",
			},
		});
	});

	it("ignores the query of a POST and the body of a GET", async () => {
		expect(
			await authorizeScopeDefaults(
				{ method: "post", query: { client_id: "c" }, body: undefined },
				find
			)
		).toBeNull();
		expect(
			await authorizeScopeDefaults(
				{ method: "GET", query: {}, body: { client_id: "c" } },
				find
			)
		).toBeNull();
	});

	it("leaves a POST that names a scope alone", async () => {
		expect(
			await authorizeScopeDefaults(
				{ method: "POST", body: { client_id: "c", scope: "mail:manage" } },
				find
			)
		).toBeNull();
	});
});

describe("registeredClientScopes", () => {
	it("reads array and space-separated rows, and null when none are recorded", () => {
		expect(registeredClientScopes({ scopes: ["openid", "mail:read"] })).toEqual(
			["openid", "mail:read"]
		);
		expect(registeredClientScopes({ scopes: "openid mail:read" })).toEqual([
			"openid",
			"mail:read",
		]);
		expect(registeredClientScopes({})).toBeNull();
		expect(registeredClientScopes({ scopes: null })).toBeNull();
		expect(registeredClientScopes(null)).toBeNull();
	});
});
