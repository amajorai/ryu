import { afterEach, expect, test } from "bun:test";
import {
	destroyVaultSecret,
	revealVaultSecret,
	setVaultSecret,
} from "./vault.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function vaultServer(reply: string, status = 200) {
	const requests: { body: string; method: string; path: string }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			requests.push({
				body: await request.text(),
				method: request.method,
				path: new URL(request.url).pathname,
			});
			return new Response(reply, {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	servers.push(server);
	return {
		requests,
		target: {
			url: `http://127.0.0.1:${server.port}`,
			token: "fixture-node",
			userJwt: null,
		},
	};
}

test("destroy decodes Core's count and preserves empty version selection", async () => {
	const { target, requests } = vaultServer(
		'{"ok":true,"destroyed":9007199254740992}'
	);
	expect(
		await destroyVaultSecret(target, "API/KEY", { scope: "user" }, [])
	).toBe(9_007_199_254_740_992);
	expect(requests).toEqual([
		{
			body: '{"scope":"user","versions":[]}',
			method: "POST",
			path: "/api/vault/secrets/API%2FKEY/destroy",
		},
	]);
	const omitted = vaultServer('{"ok":true}');
	expect(
		await destroyVaultSecret(omitted.target, "KEY", { scope: "user" })
	).toBeUndefined();
	for (const count of ['"count"', "null", "-1", "1.5"]) {
		const malformed = vaultServer(`{"ok":true,"destroyed":${count}}`);
		await expect(
			destroyVaultSecret(malformed.target, "KEY", { scope: "user" })
		).rejects.toThrow();
	}
});

test("reveal keeps plaintext and native zero-version request semantics", async () => {
	const { target, requests } = vaultServer('{"value":"雪🔐\\u0000"}');
	expect(await revealVaultSecret(target, "KEY", { scope: "user" }, 0)).toBe(
		"雪🔐\u0000"
	);
	expect(requests[0]?.body).toBe('{"scope":"user","version":0}');
	const missing = vaultServer('{"value":false}');
	await expect(
		revealVaultSecret(missing.target, "KEY", { scope: "user" })
	).rejects.toThrow("Core did not return a value.");
});

function protectedWriteReply(id: string, patch: string): string {
	const change = {
		id,
		status: "pending",
		operation: "write",
		approvals: [],
		coords: {
			environment: "default",
			name: "KEY",
			path: "/",
			scope: "user",
			scopeId: "local",
		},
		decidedAt: null,
		decidedBy: null,
		hasValue: true,
		reason: null,
		requestedAt: "2026-10-09T00:00:00Z",
		requestedBy: "local",
		requiredApprovals: 1,
	};
	return `{ "changeRequest": {${JSON.stringify(change).slice(1, -1)}, "patch": ${patch}} }`;
}

test("protected writes retain complete scalar, array, null and deep change patches", async () => {
	for (const patch of [
		"null",
		"42",
		'"future"',
		'[1,{"future":true}]',
		'{"__proto__":{"future":true}}',
	]) {
		const { target } = vaultServer(protectedWriteReply("pending", patch), 202);
		const result = await setVaultSecret(target, "KEY", {
			scope: "user",
			value: "fixture",
		});
		expect(result.kind).toBe("pending");
		if (result.kind === "pending") {
			expect(JSON.stringify(result.changeRequest.patch)).toBe(patch);
		}
	}
	const { target } = vaultServer(
		protectedWriteReply(
			"deep",
			`${"[".repeat(15_000)}null${"]".repeat(15_000)}`
		),
		202
	);
	const result = await setVaultSecret(target, "KEY", { scope: "user" });
	expect(result.kind).toBe("pending");
	if (result.kind === "pending") {
		let value = result.changeRequest.patch;
		let depth = 0;
		while (Array.isArray(value)) {
			depth++;
			value = value[0];
		}
		expect(depth).toBe(15_000);
		expect(value).toBeNull();
	}
});
