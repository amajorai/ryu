import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverEnv = fileURLToPath(new URL("./server.ts", import.meta.url));

/**
 * Load the real server env module in a fresh process, from an empty directory
 * so `dotenv/config` finds no `.env`, and report whether startup succeeded.
 * `afterLoad` is script text that runs after a successful load and may read
 * the loaded `env`.
 */
function loadServerEnv(overrides: Record<string, string>, afterLoad = "") {
	const run = spawnSync(
		process.execPath,
		[
			"-e",
			`const { env } = await import(${JSON.stringify(serverEnv)}); ${afterLoad}`,
		],
		{
			cwd: mkdtempSync(join(tmpdir(), "ryu-env-test-")),
			encoding: "utf8",
			env: {
				BETTER_AUTH_SECRET: "env-test-secret-that-is-long-enough-2026",
				BETTER_AUTH_URL: "http://localhost:3000",
				DATABASE_URL: "mongodb://127.0.0.1:27017/ryu-env-test",
				NODE_ENV: "production",
				PATH: process.env.PATH ?? "",
				POLAR_ACCESS_TOKEN: "env-test-token",
				POLAR_SUCCESS_URL: "http://localhost:3001/success",
				...overrides,
			},
			timeout: 60_000,
		}
	);
	if (run.error) {
		throw run.error;
	}
	return { output: `${run.stdout}${run.stderr}`, status: run.status };
}

describe("RYU_DB_MASTER_KEY startup validation", () => {
	test(
		"refuses a key that does not decode to 32 bytes, and accepts a valid one",
		() => {
			// "too-short": nonempty, so a presence-only check would accept it, while
			// every seal would throw at write time.
			const malformed = loadServerEnv({ RYU_DB_MASTER_KEY: "dG9vLXNob3J0" });
			expect(malformed.status).not.toBe(0);
			expect(malformed.output).toContain("RYU_DB_MASTER_KEY");

			const valid = loadServerEnv({
				RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
			});
			expect(valid.status, valid.output).toBe(0);

			const keyringOnly = loadServerEnv({
				RYU_DB_MASTER_KEYS: `2:${Buffer.alloc(32, 9).toString("base64")}`,
			});
			expect(keyringOnly.status, keyringOnly.output).toBe(0);

			const missing = loadServerEnv({});
			expect(missing.status).not.toBe(0);
			expect(missing.output).toContain("RYU_DB_MASTER_KEY is required");
		},
		{ timeout: 120_000 }
	);
});

/** Load the server env with a valid base and print the resolved mode. */
function loadDeploymentMode(value: string | undefined) {
	return loadServerEnv(
		{
			RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
			...(value === undefined ? {} : { RYU_DEPLOYMENT_MODE: value }),
		},
		'console.log("mode=[" + env.RYU_DEPLOYMENT_MODE + "]");'
	);
}

describe("RYU_DEPLOYMENT_MODE", () => {
	test(
		"defaults to cloud, so a hosted deployment that sets nothing is unchanged",
		() => {
			for (const value of [undefined, "", "cloud", " Cloud "]) {
				const run = loadDeploymentMode(value);
				expect(run.status, run.output).toBe(0);
				expect(run.output).toContain("mode=[cloud]");
			}
		},
		{ timeout: 240_000 }
	);

	test(
		"is self-hosted only when stated, and refuses an unknown value at startup",
		() => {
			for (const value of ["self-hosted", " Self-Hosted "]) {
				const run = loadDeploymentMode(value);
				expect(run.status, run.output).toBe(0);
				expect(run.output).toContain("mode=[self-hosted]");
			}

			// A near miss must stop the server instead of silently picking a mode.
			for (const value of ["selfhosted", "on-prem", "true"]) {
				const run = loadDeploymentMode(value);
				expect(run.status, run.output).not.toBe(0);
				expect(run.output).toContain("RYU_DEPLOYMENT_MODE");
				expect(run.output).not.toContain("mode=[");
			}
		},
		{ timeout: 300_000 }
	);
});
