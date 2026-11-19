// `ryu-cli secrets run --broker` - dummy `__ryu_broker__` credentials for the
// brokered services, and the project file's `broker` block (including the
// `.ryu/vault.json` location).

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { explicitPlaceholders } from "../cli/secrets-broker-placeholders.ts";
import { findProject } from "../cli/secrets-project.ts";
import { environments, fakeNode, json, runSecrets } from "./secrets-fixture.ts";

let dir = "";
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = "";
	}
});

const T = "2030-01-01T00:00:00Z";
const CA = "-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";

async function brokerNode(services: string[], extra = {}) {
	dir = await mkdtemp(join(tmpdir(), "ryu-placeholders-"));
	await writeFile(join(dir, "ca.pem"), CA);
	await writeFile(join(dir, "bundle.pem"), CA);
	const proxy = "http://rvb:rvb_secret@127.0.0.1:8123";
	const node = fakeNode({
		"POST /api/vault/broker/sessions": (call) =>
			Response.json({
				token: "rvb_secret",
				session: {
					id: "bs_1",
					environment: "dev",
					services: JSON.parse(call.body).services ?? services,
					label: "",
					mintedBy: "user:u1",
					createdAt: T,
					expiresAt: T,
				},
				proxy: {
					url: "http://127.0.0.1:8123",
					port: 8123,
					caPath: join(dir, "ca.pem"),
					caBundlePath: join(dir, "bundle.pem"),
					caUrl: "/api/vault/broker/ca.pem",
					env: { HTTPS_PROXY: proxy, OPENAI_API_KEY: "kept-from-core" },
				},
			}),
		"DELETE /api/vault/broker/sessions/bs_1": json({ revoked: true }),
		...extra,
	});
	node.target.url = "http://127.0.0.1:7777";
	return node;
}

function capture() {
	const seen: { env: Record<string, string> } = { env: {} };
	return {
		seen,
		spawn: (_cmd: string[], env: Record<string, string>) => {
			seen.env = env;
			return Promise.resolve(0);
		},
	};
}

test("catalog services get their SDK variables as placeholders without an extra request", async () => {
	const node = await brokerNode([]);
	const child = capture();
	const result = await runSecrets(
		["run", "--no-project", "--broker", "anthropic,openai", "--", "claude"],
		node,
		{ spawn: child.spawn }
	);
	expect(result.code).toBe(0);
	expect(child.seen.env.ANTHROPIC_API_KEY).toBe("__ryu_broker__");
	// A variable the proxy environment already sets is never replaced.
	expect(child.seen.env.OPENAI_API_KEY).toBe("kept-from-core");
	expect(node.calls.map((call) => call.route)).toEqual([
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
});

test("custom services map through their auth references; --placeholder adds names", async () => {
	const service = {
		name: "llm-prod",
		host: "llm.internal",
		pathPrefix: "/",
		environment: "dev",
		enabled: true,
		auth: { type: "bearer", token: "secret:LLM_API_KEY" },
		createdAt: T,
		updatedAt: T,
	};
	const node = await brokerNode([], {
		"GET /api/vault/broker/services": json({ services: [service] }),
	});
	const child = capture();
	const result = await runSecrets(
		[
			"run",
			"--no-project",
			"--broker",
			"llm-prod",
			"--placeholder",
			"EXTRA_KEY",
			"--",
			"app",
		],
		node,
		{ spawn: child.spawn }
	);
	expect(result.code).toBe(0);
	expect(child.seen.env.LLM_API_KEY).toBe("__ryu_broker__");
	expect(child.seen.env.EXTRA_KEY).toBe("__ryu_broker__");
	expect(JSON.stringify(child.seen.env)).not.toContain("secret:");
});

test("--no-placeholders turns them off; placeholder flags need --broker", async () => {
	const node = await brokerNode([]);
	const child = capture();
	await runSecrets(
		[
			"run",
			"--no-project",
			"--broker",
			"anthropic",
			"--no-placeholders",
			"--",
			"x",
		],
		node,
		{ spawn: child.spawn }
	);
	expect(child.seen.env.ANTHROPIC_API_KEY).toBeUndefined();
	const misuse = await runSecrets(
		["run", "--no-project", "--placeholder", "A", "--", "x"],
		node
	);
	expect(misuse.code).toBe(2);
	expect(() =>
		explicitPlaceholders(parseSecretsArgs(["--placeholder", "A-B"]))
	).toThrow();
	expect(
		explicitPlaceholders(
			parseSecretsArgs(["--placeholder", "A, B", "--placeholder=C"])
		)
	).toEqual(["A", "B", "C"]);
});

test("a .ryu/vault.json broker block makes run broker its services", async () => {
	const node = await brokerNode([]);
	await mkdir(join(dir, ".ryu"));
	await writeFile(
		join(dir, ".ryu", "vault.json"),
		JSON.stringify({
			version: 1,
			environment: "dev",
			broker: { services: ["github"], placeholders: ["GH_HOST_TOKEN"] },
		})
	);
	const child = capture();
	const result = await runSecrets(["run", "--", "gh", "pr", "list"], node, {
		cwd: join(dir, ".ryu"),
		spawn: child.spawn,
	});
	expect(result.code).toBe(0);
	expect(result.err).toContain("brokering github");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toMatchObject({
		services: ["github"],
		environment: "dev",
	});
	expect(child.seen.env.GITHUB_TOKEN).toBe("__ryu_broker__");
	expect(child.seen.env.GH_HOST_TOKEN).toBe("__ryu_broker__");

	// --no-broker runs with values instead.
	const values = fakeNode({
		"POST /api/vault/export": json({
			format: "json",
			contentType: "application/json",
			count: 1,
			environment: "dev",
			path: "/",
			content: JSON.stringify({ A: "1" }),
		}),
	});
	const plain = capture();
	const valueRun = await runSecrets(
		["run", "--no-broker", "--", "app"],
		values,
		{
			cwd: dir,
			spawn: plain.spawn,
		}
	);
	expect(valueRun.code).toBe(0);
	expect(values.calls.some((call) => call.route.includes("broker"))).toBe(
		false
	);
	expect(plain.seen.env.A).toBe("1");
});

test("both project files in one directory are refused; init writes .ryu/vault.json", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-project-"));
	await mkdir(join(dir, ".ryu"));
	const config = JSON.stringify({ version: 1, environment: "dev" });
	await writeFile(join(dir, ".ryu", "vault.json"), config);
	expect((await findProject(dir))?.file).toBe(join(dir, ".ryu", "vault.json"));
	await writeFile(join(dir, ".ryu-vault.json"), config);
	await expect(findProject(dir)).rejects.toThrow("Keep one");

	const fresh = await mkdtemp(join(tmpdir(), "ryu-init-"));
	try {
		const node = fakeNode({
			"GET /api/vault/environments": json(environments("dev")),
		});
		const init = await runSecrets(
			[
				"init",
				"--env",
				"dev",
				"--broker",
				"anthropic,github",
				"--placeholder",
				"CLAUDE_KEY",
				"--out",
				".ryu/vault.json",
			],
			node,
			{ cwd: fresh }
		);
		expect(init.code).toBe(0);
		expect(
			JSON.parse(await readFile(join(fresh, ".ryu", "vault.json"), "utf8"))
		).toEqual({
			version: 1,
			environment: "dev",
			broker: {
				services: ["anthropic", "github"],
				placeholders: ["CLAUDE_KEY"],
			},
		});
		const badOut = await runSecrets(
			["init", "--env", "dev", "--out", "elsewhere.json"],
			node,
			{ cwd: fresh }
		);
		expect(badOut.code).toBe(2);
		const loosePlaceholder = await runSecrets(
			["init", "--env", "dev", "--placeholder", "X", "--force"],
			node,
			{ cwd: fresh }
		);
		expect(loosePlaceholder.code).toBe(2);
	} finally {
		await rm(fresh, { recursive: true, force: true });
	}
});
