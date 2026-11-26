import { describe, expect, it } from "bun:test";
import { runWithRequestState } from "@better-auth/core/context";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import {
	type AuthRequestScope,
	currentAuthRequestScope,
	loadAuthRequestScope,
} from "./auth-request-scope.ts";

describe("the scope of the Better Auth call in progress", () => {
	it("is absent outside a call and distinct for every call", async () => {
		await loadAuthRequestScope();
		expect(currentAuthRequestScope()).toBeUndefined();

		const first = new WeakMap();
		const second = new WeakMap();
		const seen = await Promise.all([
			runWithRequestState(first, async () => {
				await Promise.resolve();
				return currentAuthRequestScope();
			}),
			runWithRequestState(second, async () => {
				await Promise.resolve();
				return currentAuthRequestScope();
			}),
		]);
		expect(seen[0]).toBe(first);
		expect(seen[1]).toBe(second);
		expect(currentAuthRequestScope()).toBeUndefined();
	});

	it("is opened by Better Auth for an HTTP call and for auth.api alike", async () => {
		await loadAuthRequestScope();
		const scopes: (AuthRequestScope | undefined)[] = [];
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			database: memoryAdapter({
				account: [],
				session: [],
				user: [],
				verification: [],
			}),
			hooks: {
				before: createAuthMiddleware(async () => {
					await Promise.resolve();
					scopes.push(currentAuthRequestScope());
				}),
			},
			secret: "auth-request-scope-test-secret-at-least-32-characters",
		});
		await auth.api.getSession({ headers: new Headers() });
		await auth.handler(
			new Request("http://localhost:3000/api/auth/get-session")
		);
		await auth.api.getSession({ headers: new Headers() });
		expect(scopes).toHaveLength(3);
		expect(scopes.every((scope) => scope !== undefined)).toBe(true);
		expect(new Set(scopes).size).toBe(3);
	});
});
