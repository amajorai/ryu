import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const authIndex = fileURLToPath(new URL("./index.ts", import.meta.url));

const childEnv = (nodeEnv: string, turnstileSecret: string) => ({
	...process.env,
	BETTER_AUTH_SECRET: "auth-config-test-secret-long-enough-2026",
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL:
		process.env.DATABASE_URL ||
		"mongodb://127.0.0.1:27017/ryu-auth-config-test",
	NODE_ENV: nodeEnv,
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
	TURNSTILE_SECRET_KEY: turnstileSecret,
});

const runAuthConfigCheck = (
	source: string,
	nodeEnv = "test",
	turnstileSecret = ""
): true => {
	const run = spawnSync(process.execPath, ["-e", source], {
		cwd: repoRoot,
		encoding: "utf8",
		env: childEnv(nodeEnv, turnstileSecret),
		timeout: 60_000,
	});

	if (run.error) {
		throw run.error;
	}
	if (run.status !== 0) {
		throw new Error(
			`Auth configuration process exited ${run.status}: ${run.stderr}`
		);
	}
	return true;
};

const configuresCaptchaAsExpected = (
	turnstileSecret: string,
	nodeEnv = "test"
): boolean => {
	const shouldInstall =
		turnstileSecret.trim().length > 0 || nodeEnv === "production";
	const source = `
		const { auth } = await import(${JSON.stringify(authIndex)});
		const avatar = auth.options.user?.additionalFields?.avatarId;
        if (!(avatar?.type === "string" && avatar.required === false && avatar.input === false)) {
            process.exit(1);
        }
		const cache = auth.options.session?.cookieCache;
		if (!(cache?.enabled && cache.maxAge === 60 && cache.strategy === "compact")) {
			process.exit(1);
		}
		const hasCaptcha = (auth.options.plugins ?? [])
			.map((plugin) => plugin.id)
			.some((id) => id === "captcha");
		process.exit(hasCaptcha === ${shouldInstall} ? 0 : 1);
	`;
	return runAuthConfigCheck(source, nodeEnv, turnstileSecret);
};

describe("Better Auth CAPTCHA configuration", () => {
	test(
		"keeps optional server-owned avatars and installs CAPTCHA when configured",
		() => {
			expect(configuresCaptchaAsExpected("")).toBe(true);
			expect(configuresCaptchaAsExpected("synthetic-turnstile-secret")).toBe(
				true
			);
			expect(configuresCaptchaAsExpected("", "production")).toBe(true);
		},
		{ timeout: 180_000 }
	);
});

describe("Better Auth Enterprise identity plugin configuration", () => {
	test(
		"admits SSO members only through the seat gate and enforces the live SSO entitlement",
		() => {
			// The SSO plugin's own organization provisioning writes the member row
			// past `beforeAddMember` (the paid-seat and business-email gate), so it
			// must stay disabled; `resolveUser` is the live entitlement gate.
			const source = `
				const { auth } = await import(${JSON.stringify(authIndex)});
				const sso = (auth.options.plugins ?? []).find((plugin) => plugin.id === "sso");
				const options = sso?.options;
				const ok =
					options?.organizationProvisioning?.disabled === true &&
					typeof options.resolveUser === "function";
				process.exit(ok ? 0 : 1);
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
			expect(run.status, run.stderr).toBe(0);
		},
		{ timeout: 120_000 }
	);
});

describe("Better Auth organization plugin configuration", () => {
	test(
		"states the 100 member/invitation caps and stamps the creator as primary owner at insert",
		() => {
			// Each failed check exits with its own code, so a failure names it.
			const source = `
				const { auth } = await import(${JSON.stringify(authIndex)});
				const organization = (auth.options.plugins ?? []).find((plugin) => plugin.id === "organization");
				const options = organization?.options;
				if (!options) {
					process.exit(2);
				}
				// Numeric 100 is Better Auth's own default, stated: it is also the
				// default listMembers / getFullOrganization page size. A numeric
				// Infinity would make those reads unbounded; lifting the cap takes the
				// function form and paged member readers (see index.ts).
				if (options.membershipLimit !== 100 || options.invitationLimit !== 100) {
					process.exit(3);
				}
				const before = options.organizationHooks?.beforeCreateOrganization;
				if (typeof before !== "function") {
					process.exit(4);
				}
				const user = {
					email: "founder@acme-signup.example.test",
					emailVerified: true,
					id: "user_primary_owner",
				};
				const personal = await before({
					organization: { name: "Personal", primaryOwnerUserId: "user_other", slug: "personal-founder" },
					user,
				});
				if (personal?.data?.primaryOwnerUserId !== user.id) {
					process.exit(5);
				}
				const teams = await before({
					organization: { name: "Acme", primaryOwnerUserId: "user_other", slug: "acme" },
					user,
				});
				if (teams?.data?.primaryOwnerUserId !== user.id) {
					process.exit(6);
				}
				process.exit(0);
			`;
			expect(runAuthConfigCheck(source)).toBe(true);
		},
		{ timeout: 120_000 }
	);
});
