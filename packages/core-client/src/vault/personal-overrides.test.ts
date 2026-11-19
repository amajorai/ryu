import { expect, test } from "bun:test";
import { ApiError } from "../client.ts";
import {
	getVaultPersonalOverrides,
	setVaultPersonalOverrides,
} from "./personal-overrides.ts";

interface Seen {
	body: string | null;
	method: string;
	url: string;
}

function fakeTarget(reply: () => Response) {
	const seen: Seen[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: (url: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(url),
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : null,
			});
			return Promise.resolve(reply());
		},
	};
	return { seen, target };
}

test("reads the caller's setting", async () => {
	const { seen, target } = fakeTarget(() =>
		Response.json({ enabled: true, userId: "user-1" })
	);
	await expect(getVaultPersonalOverrides(target)).resolves.toEqual({
		enabled: true,
		userId: "user-1",
	});
	expect(seen).toEqual([
		{
			url: "https://node.example/api/vault/personal-overrides",
			method: "GET",
			body: null,
		},
	]);
});

test("switches the setting off and on with a PUT", async () => {
	let enabled = true;
	const { seen, target } = fakeTarget(() =>
		Response.json({ enabled, userId: "user-1" })
	);
	enabled = false;
	await expect(setVaultPersonalOverrides(target, false)).resolves.toEqual({
		enabled: false,
		userId: "user-1",
	});
	enabled = true;
	await setVaultPersonalOverrides(target, true);
	expect(seen.map(({ method, body }) => ({ method, body }))).toEqual([
		{ method: "PUT", body: '{"enabled":false}' },
		{ method: "PUT", body: '{"enabled":true}' },
	]);
});

test("a refusal surfaces as an ApiError and a malformed reply is rejected", async () => {
	const refused = fakeTarget(() =>
		Response.json(
			{ error: "vault_denied: personal overrides need a signed-in user" },
			{ status: 403 }
		)
	);
	const error = await getVaultPersonalOverrides(refused.target).catch(
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).status).toBe(403);

	const malformed = fakeTarget(() => Response.json({ enabled: "yes" }));
	await expect(getVaultPersonalOverrides(malformed.target)).rejects.toThrow();
});
