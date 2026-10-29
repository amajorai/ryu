import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import {
	applyDevBinaryOverrides,
	coreBinaryPath,
	coreHealthUrl,
	hasHealthyCore,
	parseRestartOptions,
	restartHostArgs,
} from "./dev-runtime.mjs";

test("Core probes the selected profile and explicit overrides", () => {
	assert.equal(coreHealthUrl({}), "http://127.0.0.1:8980/api/health");
	for (const [profile, port] of [
		["release", 7980],
		["dev", 8980],
		["canary", 9980],
		["nightly", 10_980],
		["beta", 11_980],
	]) {
		assert.equal(
			coreHealthUrl({ RYU_PROFILE: profile }),
			`http://127.0.0.1:${port}/api/health`
		);
	}
	assert.equal(
		coreHealthUrl({ RYU_PORT_OFFSET: "42" }),
		"http://127.0.0.1:8022/api/health"
	);
	assert.equal(
		coreHealthUrl({ RYU_PORT_OFFSET: "50001" }),
		"http://127.0.0.1:8980/api/health"
	);
	assert.equal(
		coreHealthUrl({ RYU_BIND: "0.0.0.0:12345" }),
		"http://127.0.0.1:12345/api/health"
	);
	assert.equal(
		coreHealthUrl({ RYU_BIND: "[::]:12345" }),
		"http://[::1]:12345/api/health"
	);
	assert.throws(
		() => coreHealthUrl({ RYU_PROFILE: "unknown" }),
		/Unknown RYU_PROFILE/
	);
});

// biome-ignore lint/style/noDoneCallback: Node's test context registers cleanup, not a completion callback.
test("launcher attaches without building or stopping the healthy Core", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		assert.equal(request.url, "/api/health");
		requests += 1;
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify({ status: "ok", version: "1.0.0", capabilities: [] })
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => server.close());
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}/api/health`;
	assert.equal(await hasHealthyCore(url), true);
	const child = spawn(
		process.execPath,
		[new URL("./dev.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")],
		{
			env: {
				...process.env,
				RYU_BIND: `127.0.0.1:${port}`,
				RYU_PROFILE: "dev",
				CARGO_TARGET_DIR: "unused-test-target",
			},
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
	t.after(() => child.kill());
	let output = "";
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`launcher did not attach: ${output}`)),
			10_000
		);
		child.once("error", reject);
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("reusing Core")) {
				clearTimeout(timeout);
				resolve();
			}
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
	});
	assert.equal(child.exitCode, null);
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
	assert.equal(await hasHealthyCore(url), true);
	assert.ok(requests >= 3);
});

// biome-ignore lint/style/noDoneCallback: Node's test context registers cleanup, not a completion callback.
test("unrelated and unavailable listeners are not accepted as Core", async (t) => {
	const server = createServer((_, response) => response.end('{"status":"ok"}'));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}/api/health`;
	assert.equal(await hasHealthyCore(url), false);
	await new Promise((resolve) => server.close(resolve));
	t.after(() => server.close());
	assert.equal(await hasHealthyCore(url), false);
});

test("automatic startup cannot sweep backend listeners or globally kill Core", async () => {
	const cleanup = await readFile(
		new URL("../../../scripts/free-ports.mjs", import.meta.url),
		"utf8"
	);
	const launcher = await readFile(new URL("./dev.js", import.meta.url), "utf8");
	assert.doesNotMatch(
		cleanup,
		/CORE_PROFILE_BASE_PORTS|PROFILE_OFFSETS|7980|7981|8980|8981|3030|4030|5176/
	);
	assert.doesNotMatch(launcher, /taskkill|pkill/);
});

test("dev:restart waits for idle unless asked to restart now", () => {
	assert.deepEqual(parseRestartOptions([]), { now: false, wait: false });
	assert.deepEqual(restartHostArgs(parseRestartOptions([])), [
		"--restart-dev-execution",
	]);
	assert.deepEqual(restartHostArgs(parseRestartOptions(["--now", "--wait"])), [
		"--restart-dev-execution",
		"--now",
	]);
	assert.throws(() => parseRestartOptions(["--force"]), /Unknown/);
});

test("dev:restart runs the Core binary from the shared debug target", () => {
	assert.equal(
		coreBinaryPath("/repo/.cargo-target-shared", "linux"),
		"/repo/.cargo-target-shared/debug/ryu-core"
	);
	assert.match(coreBinaryPath("target", "win32"), /ryu-core\.exe$/);
});

test("dev binary overrides point at built binaries and respect caller overrides", () => {
	const built = new Set([
		path.join("/target", "debug", "ryu-gateway"),
		path.join("/target", "debug", "ryu-mail"),
	]);
	const exists = (candidate) => built.has(candidate);
	const env = { RYU_MAIL_BIN: "/custom/ryu-mail" };
	const { warnings } = applyDevBinaryOverrides("/target", { env, exists });
	assert.equal(
		env.RYU_GATEWAY_BIN,
		path.join("/target", "debug", "ryu-gateway")
	);
	assert.equal(env.RYU_MAIL_BIN, "/custom/ryu-mail");
	assert.equal(env.RYU_TEAMS_BIN, undefined);
	assert.equal(env.RYU_BROWSER_BIN, undefined);
	assert.ok(warnings.some((warning) => warning.includes("ryu-teams")));

	const forced = { RYU_MAIL_BIN: "/custom/ryu-mail" };
	applyDevBinaryOverrides("/target", { env: forced, exists, overwrite: true });
	assert.equal(forced.RYU_MAIL_BIN, path.join("/target", "debug", "ryu-mail"));

	const missing = {};
	const result = applyDevBinaryOverrides("/target", {
		env: missing,
		exists: () => false,
	});
	assert.equal(missing.RYU_GATEWAY_BIN, undefined);
	assert.ok(result.warnings.some((warning) => warning.includes("ryu-gateway")));
});
