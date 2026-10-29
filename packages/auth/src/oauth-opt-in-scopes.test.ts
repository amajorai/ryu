import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The shipping Better Auth instance registers `mail:manage` as a grantable
// OAuth scope that a client must ask for by name: it is registrable (Better
// Auth stores every dynamic or CIMD client with the default-plus-allowed
// union, so the stored row lists it) but discovery metadata does not advertise
// it. This reads the shipping plugin options; what they do at the real
// endpoint (stored DCR scopes, GET and POST authorize without `scope`, the
// protected-resource metadata) is exercised by
// `lib/oauth-authorize-scope.integration.test.ts`.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const authIndex = fileURLToPath(new URL("./index.ts", import.meta.url));

interface ProviderScopes {
	advertised: string[];
	allowed: string[];
	defaults: string[];
	scopes: string[];
}

function providerScopes(): ProviderScopes {
	const source = `
		const { auth } = await import(${JSON.stringify(authIndex)});
		const provider = (auth.options.plugins ?? []).find(
			(plugin) => plugin.id === "oauth-provider"
		);
		const options = provider?.options ?? {};
		process.stdout.write("\\nSCOPES " + JSON.stringify({
			advertised: options.advertisedMetadata?.scopes_supported ?? [],
			allowed: options.clientRegistrationAllowedScopes ?? [],
			defaults: options.clientRegistrationDefaultScopes ?? [],
			scopes: options.scopes ?? [],
		}) + "\\n");
		process.exit(0);
	`;
	const run = spawnSync(process.execPath, ["-e", source], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			BETTER_AUTH_SECRET: "auth-config-test-secret-long-enough-2026",
			BETTER_AUTH_URL: "http://localhost:3000",
			DATABASE_URL:
				process.env.DATABASE_URL ||
				"mongodb://127.0.0.1:27017/ryu-auth-config-test",
			NODE_ENV: "test",
			POLAR_ACCESS_TOKEN: "local-test",
			POLAR_BILLING_AUTHORITY: "local",
			POLAR_SERVER: "sandbox",
			POLAR_SUCCESS_URL: "http://localhost:3001/success",
			RYU_DIR: "/tmp/ryu-dev-headless",
			RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
			RYU_KEYCHAIN: "off",
			RYU_PROFILE: "dev",
		},
		timeout: 60_000,
	});
	if (run.error) {
		throw run.error;
	}
	const line = run.stdout
		.split("\n")
		.find((entry) => entry.startsWith("SCOPES "));
	if (run.status !== 0 || !line) {
		throw new Error(
			`Auth configuration process exited ${run.status}: ${run.stderr}`
		);
	}
	return JSON.parse(line.slice("SCOPES ".length)) as ProviderScopes;
}

describe("Better Auth OAuth opt-in scopes", () => {
	test(
		"grants and registers mail:manage but never advertises it",
		() => {
			const { advertised, allowed, defaults, scopes } = providerScopes();
			expect(scopes).toContain("mail:manage");
			// Registrable: the persisted union is defaults plus allowed.
			expect([...new Set([...defaults, ...allowed])].sort()).toEqual(
				[...scopes].sort()
			);
			const withoutManage = scopes.filter((scope) => scope !== "mail:manage");
			expect(defaults).toEqual(withoutManage);
			// Discovery leaves it out, so MCP clients do not request it unasked.
			expect(advertised).toEqual(withoutManage);
			expect(advertised).toContain("mail:send");
		},
		{ timeout: 120_000 }
	);
});
