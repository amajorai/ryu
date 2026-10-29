import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	type McpTokenExchange,
	startMcpOAuthFlow,
} from "./lib/mcp-oauth-flow.fixture.ts";

// MCP OAuth through the shipping Better Auth instance against a real Mongo
// replica set; see ./lib/mcp-oauth-flow.fixture.ts for what runs and what
// stands in. `apps/server/src/hosted-mcp.provider-tokens.test.ts` sends the
// tokens this flow issues to the hosted MCP resource.
//
// Regression: `oauthAccessToken.accessToken` was declared `unique` (and
// `required`) in the Mongoose mirror, so autoIndex built a non-sparse unique
// `accessToken_1`. The provider stores its token in `token` and never writes
// `accessToken`, so every row indexed as `accessToken: null` and only the
// first access token in a database could ever be issued.

const database = new URL(
	process.env.DATABASE_URL ??
		"mongodb://127.0.0.1:27019/ryu-api-tests?replicaSet=ryu-api-tests"
);
database.pathname = `/ryu_mcp_oauth_tokens_${randomUUID().replaceAll("-", "")}`;
const flow = await startMcpOAuthFlow({ databaseUrl: database.href });

afterAll(async () => {
	await flow.close();
});

test("one user and one MCP client receive a second and a third access token, each distinct and usable, and the provider's rows never carry the legacy accessToken field", async () => {
	const email = `mona-${randomUUID()}@mcp-proof.example.test`;
	expect((await flow.signUpAndVerify(email)).email).toBe(email);
	const clientId = await flow.registerMcpClient();

	// A reconnecting MCP client: same user, same client, consent already stored
	// after the first authorization.
	const exchanges: McpTokenExchange[] = [];
	for (const _attempt of [1, 2, 3]) {
		exchanges.push(await flow.issueAccessToken(clientId));
	}
	expect(
		exchanges.map(({ duplicateKeyErrors, status }) => ({
			duplicateKeyErrors,
			status,
		}))
	).toEqual([
		{ duplicateKeyErrors: [], status: 200 },
		{ duplicateKeyErrors: [], status: 200 },
		{ duplicateKeyErrors: [], status: 200 },
	]);
	const issued = exchanges.map(({ accessToken }) => accessToken ?? "");
	expect(new Set(issued).size).toBe(3);
	for (const token of issued) {
		expect(await flow.userinfo(token)).toEqual({ email, status: 200 });
	}

	// Root-cause evidence from the provider's own writes: an opaque token's
	// digest lives in `token` (hashed, never the bearer value) and no row has
	// an `accessToken` field for a unique index to collide on.
	const rows = await flow.client
		.collection("oauthAccessToken")
		.find({ clientId })
		.toArray();
	expect(rows).toHaveLength(3);
	for (const row of rows) {
		expect(Object.hasOwn(row, "accessToken")).toBe(false);
		expect(typeof row.token).toBe("string");
		expect(issued).not.toContain(row.token);
	}
}, 120_000);
