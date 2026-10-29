import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `resolveSignupRole` as Better Auth applies it: the role a new account is
 * inserted with.
 *
 * The role is stamped by Ryu's `user.create.before`, not patched in afterwards,
 * so it has to win the merge Better Auth 1.7.1 performs: plugin database hooks
 * run first and `options.databaseHooks` last (context/helpers.mjs), and each
 * hook's `data` is spread over the previous result (db/with-hooks.mjs). The
 * admin plugin's hook is `{ role: "user", ...user }`, and "user" is what the
 * waitlist treats as approved, so a lost merge would fail the queue open.
 *
 * The hooks are inline in index.ts, whose import connects the whole auth
 * config, so they run in a child process like index.test.ts does. One child
 * covers every case; the environment is switched between calls because the
 * waitlist helpers read it at call time.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const authIndex = fileURLToPath(new URL("./index.ts", import.meta.url));
const RESULT_MARKER = "SIGNUP_ROLE_RESULT ";

interface MergedSignup {
	emailVerifiedAt: boolean;
	referralCode: boolean;
	role: string | null;
}

type SignupCase =
	| "adminEmail"
	| "anonymous"
	| "bypassed"
	| "callerRoleOverridden"
	| "queued"
	| "verified"
	| "verifiedAdminEmail";

const runSignupHooks = (): Record<SignupCase, MergedSignup> => {
	const source = `
		const { auth } = await import(${JSON.stringify(authIndex)});
		const adminPlugin = (auth.options.plugins ?? []).find((plugin) => plugin.id === "admin");
		const pluginBefore = adminPlugin?.init?.()?.options?.databaseHooks?.user?.create?.before;
		const ryuBefore = auth.options.databaseHooks?.user?.create?.before;
		if (typeof pluginBefore !== "function" || typeof ryuBefore !== "function") {
			process.exit(2);
		}
		// Better Auth's createWithHooks: plugin hooks, then the options hook, each
		// result's data spread over the data so far.
		const merge = async (user) => {
			let data = user;
			for (const hook of [pluginBefore, ryuBefore]) {
				const result = await hook(data, null);
				if (result && typeof result === "object" && "data" in result) {
					data = { ...data, ...result.data };
				}
			}
			return {
				emailVerifiedAt: data.emailVerifiedAt instanceof Date,
				referralCode: typeof data.referralCode === "string" && data.referralCode.length > 0,
				role: data.role ?? null,
			};
		};
		const user = (email, extra = {}) => ({
			email,
			emailVerified: false,
			name: "Signup Test",
			...extra,
		});
		process.env.ADMIN_EMAILS = "staff@ryu-signup.example.test";
		delete process.env.WAITLIST_ENABLED;
		const results = {
			adminEmail: await merge(user("Staff@ryu-signup.example.test")),
			verifiedAdminEmail: await merge(user("Staff@ryu-signup.example.test", { emailVerified: true })),
			anonymous: await merge(user("guest@ryu-signup.example.test", { isAnonymous: true })),
			callerRoleOverridden: await merge(user("new@ryu-signup.example.test", { role: "admin" })),
			queued: await merge(user("new@ryu-signup.example.test")),
			verified: await merge(user("verified@ryu-signup.example.test", { emailVerified: true })),
		};
		process.env.WAITLIST_ENABLED = "false";
		results.bypassed = await merge(user("open@ryu-signup.example.test"));
		console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(results));
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
			TURNSTILE_SECRET_KEY: "",
		},
		timeout: 60_000,
	});
	if (run.error) {
		throw run.error;
	}
	if (run.status !== 0) {
		throw new Error(`Signup hook process exited ${run.status}: ${run.stderr}`);
	}
	const line = run.stdout
		.split("\n")
		.find((entry) => entry.startsWith(RESULT_MARKER));
	if (!line) {
		throw new Error(`Signup hook process printed no result: ${run.stdout}`);
	}
	return JSON.parse(line.slice(RESULT_MARKER.length));
};

describe("user.create.before signup role", () => {
	test(
		"stamps the waitlist, admin or approved role over the admin plugin default",
		() => {
			const results = runSignupHooks();

			// Allowlisted staff with a verified address get the admin-plugin
			// "admin" role (case-insensitive).
			expect(results.verifiedAdminEmail).toEqual({
				emailVerifiedAt: true,
				referralCode: true,
				role: "admin",
			});
			// An allowlisted but unproven address (email/password before the
			// mailbox link, or an SSO/SCIM-asserted one) is held on the waitlist
			// until verification promotes it.
			expect(results.adminEmail).toEqual({
				emailVerifiedAt: false,
				referralCode: true,
				role: "waitlist",
			});
			// Everyone else is queued; the plugin's "user" must not survive the merge.
			expect(results.queued).toEqual({
				emailVerifiedAt: false,
				referralCode: true,
				role: "waitlist",
			});
			// A role the caller supplied (admin createUser, SCIM, SSO) is overridden.
			expect(results.callerRoleOverridden.role).toBe("waitlist");
			// With the waitlist switched off, signups are approved at once.
			expect(results.bypassed.role).toBe("user");
			// `emailVerifiedAt` only for an account created verified.
			expect(results.verified).toEqual({
				emailVerifiedAt: true,
				referralCode: true,
				role: "waitlist",
			});
			// Guests keep the plugin default and get no referral code.
			expect(results.anonymous).toEqual({
				emailVerifiedAt: false,
				referralCode: false,
				role: "user",
			});
		},
		{ timeout: 120_000 }
	);
});
