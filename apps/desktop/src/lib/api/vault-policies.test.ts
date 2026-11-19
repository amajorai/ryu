import { afterEach, expect, test } from "bun:test";
import {
	deleteVaultPolicyDocument,
	listVaultPolicyDocuments,
	putVaultPolicyDocument,
} from "./vault-policies.ts";

const target = {
	token: "node-token",
	url: "https://policies-api.fixture",
	userJwt: null,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const RULE = {
	path: "prod/**",
	capabilities: ["write"],
	allowedParameters: { region: ["eu-*"] },
	controlGroup: { factors: [] },
	valueRules: { minLength: 16 },
	minWrappingTtlSecs: 60,
};

function serve(
	reply: unknown,
	seen: { body?: string; method: string; url: string }[]
) {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body as string | undefined,
			});
			return Promise.resolve(Response.json(reply));
		},
		{ preconnect: originalFetch.preconnect }
	);
}

test("rules keep every field Core returns, and missing bindings read as none", async () => {
	const seen: { body?: string; method: string; url: string }[] = [];
	serve({ policies: [{ name: "ci", description: "", rules: [RULE] }] }, seen);
	const listed = await listVaultPolicyDocuments(target);
	expect(listed.policies[0]?.rules[0]).toEqual(RULE);
	expect(listed.bindings).toEqual([]);
	expect(seen[0]?.url).toBe("https://policies-api.fixture/api/vault/policies");
});

test("put sends the whole document and delete names the policy", async () => {
	const seen: { body?: string; method: string; url: string }[] = [];
	serve(
		{ ok: true, policy: { name: "ci/a", description: "d", rules: [RULE] } },
		seen
	);
	const saved = await putVaultPolicyDocument(target, "ci/a", {
		description: "d",
		rules: [RULE],
	});
	expect(saved.rules[0]).toEqual(RULE);
	expect(seen[0]?.method).toBe("PUT");
	expect(seen[0]?.url).toBe(
		"https://policies-api.fixture/api/vault/policies/ci%2Fa"
	);
	expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
		description: "d",
		rules: [RULE],
	});

	serve({ ok: true, deleted: true }, seen);
	expect(await deleteVaultPolicyDocument(target, "ci")).toBe(true);
	expect(seen[1]?.method).toBe("DELETE");
});
