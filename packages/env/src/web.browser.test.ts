import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserWebEnv } from "./web.browser.ts";

const validatingEntry = fileURLToPath(new URL("./web.ts", import.meta.url));
const browserEntry = fileURLToPath(
	new URL("./web.browser.ts", import.meta.url)
);

const PUBLIC_KEYS = [
	"NEXT_PUBLIC_SERVER_URL",
	"NEXT_PUBLIC_SITE_URL",
	"NEXT_PUBLIC_CORE_URL",
	"NEXT_PUBLIC_DOCS_URL",
	"NEXT_PUBLIC_WEBAPP_URL",
	"NEXT_PUBLIC_PRODUCT_DASHBOARD_URL",
	"NEXT_PUBLIC_GOOGLE_CLIENT_ID",
	"NEXT_PUBLIC_TURNSTILE_SITE_KEY",
	"NEXT_PUBLIC_STORAGE_ENDPOINT",
	"NEXT_PUBLIC_STORAGE_BUCKET_NAME",
	"NEXT_PUBLIC_POSTHOG_KEY",
	"NEXT_PUBLIC_POSTHOG_HOST",
	"NEXT_PUBLIC_SENTRY_DSN",
] as const;

type Snapshot = Record<string, string | null>;

function snapshot(env: Record<string, string | undefined>): Snapshot {
	return Object.fromEntries(PUBLIC_KEYS.map((key) => [key, env[key] ?? null]));
}

/** Evaluate the real validating entry in a fresh process with exactly `vars`. */
function loadValidatedSnapshot(vars: Record<string, string>): Snapshot {
	const run = spawnSync(
		process.execPath,
		[
			"-e",
			`const { env } = await import(${JSON.stringify(validatingEntry)});
const keys = ${JSON.stringify(PUBLIC_KEYS)};
console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, env[k] ?? null]))));`,
		],
		{
			cwd: mkdtempSync(join(tmpdir(), "ryu-env-web-test-")),
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", ...vars },
			timeout: 60_000,
		}
	);
	if (run.error) {
		throw run.error;
	}
	if (run.status !== 0) {
		throw new Error(`web.ts failed to load:\n${run.stdout}${run.stderr}`);
	}
	return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
}

const CASES: Record<string, Record<string, string>> = {
	"required only, schema defaults apply": {
		NEXT_PUBLIC_SERVER_URL: "https://api.example.test",
	},
	"empty strings read as missing": {
		NEXT_PUBLIC_SERVER_URL: "https://api.example.test",
		NEXT_PUBLIC_SITE_URL: "",
		NEXT_PUBLIC_CORE_URL: "",
		NEXT_PUBLIC_POSTHOG_HOST: "",
		NEXT_PUBLIC_SENTRY_DSN: "",
	},
	"configured values pass through": Object.fromEntries(
		PUBLIC_KEYS.map((key) => [key, `https://${key.toLowerCase()}.example.test`])
	),
};

describe("@ryu/env/web browser entry", () => {
	test(
		"resolves the same public values as the validating entry",
		() => {
			for (const [name, vars] of Object.entries(CASES)) {
				expect(snapshot(createBrowserWebEnv(vars, false)), name).toEqual(
					loadValidatedSnapshot(vars)
				);
			}
		},
		{ timeout: 120_000 }
	);

	test(
		"matches the validating entry when SKIP_ENV_VALIDATION is set",
		() => {
			const vars = CASES["empty strings read as missing"] ?? {};
			expect(snapshot(createBrowserWebEnv(vars, true))).toEqual(
				loadValidatedSnapshot({ ...vars, SKIP_ENV_VALIDATION: "1" })
			);
		},
		{ timeout: 60_000 }
	);

	test("refuses non-public keys like the t3-env client proxy", () => {
		const env = createBrowserWebEnv(
			{ NEXT_PUBLIC_SERVER_URL: "https://api.example.test" },
			false
		) as unknown as Record<string, unknown>;
		expect(() => env.DATABASE_URL).toThrow("server-side environment variable");
		expect(env.__esModule).toBeUndefined();
		expect(env.NEXT_PUBLIC_SERVER_URL).toBe("https://api.example.test");
	});

	test("is selected only for browser bundles and ships no validator", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8")
		);
		expect(manifest.exports["./web"]).toEqual({
			browser: "./src/web.browser.ts",
			default: "./src/web.ts",
		});
		const source = readFileSync(browserEntry, "utf8");
		const valueImports = source
			.split("\n")
			.filter((line) => /^import\s(?!type\s)/.test(line));
		expect(valueImports).toEqual([]);
	});
});
