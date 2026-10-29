import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import {
	gatewayConfigDiff,
	parseGatewayConfigPatch,
} from "../cli/gatewayConfig.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

let tempDir = "";

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function captureIo() {
	let stdout = "";
	let stderr = "";
	return {
		io: {
			out: (value) => {
				stdout += value;
			},
			err: (value) => {
				stderr += value;
			},
		} satisfies CliIO,
		out: () => stdout,
		err: () => stderr,
	};
}

function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: () => Promise.reject(new Error("unexpected app command")),
		streamChat: () => Promise.reject(new Error("unexpected chat stream")),
		...overrides,
	};
}

function configFile(contents: string): string {
	tempDir = mkdtempSync(join(tmpdir(), "ryu-gateway-config-cli-"));
	const path = join(tempDir, "gateway.toml");
	writeFileSync(path, contents, "utf8");
	return path;
}

const SOURCE = `[firewall]
enabled = true
policy = "sanitize"

[budgets.session]
limit = 1000000
action = "stop"

[auth]
require_auth = true
api_keys = [{ name = "ci", key = "secret-token", trusted_forwarder = false }]
`;

test("Gateway TOML parser validates the exact Core-writable subset and nested fields", () => {
	expect(parseGatewayConfigPatch(SOURCE)).toEqual({
		firewall: { enabled: true, policy: "sanitize" },
		budgets: { session: { limit: 1_000_000, action: "stop" } },
		auth: {
			require_auth: true,
			api_keys: [{ name: "ci", key: "secret-token", trusted_forwarder: false }],
		},
	});
	expect(() =>
		parseGatewayConfigPatch('[providers]\nopenai = "env"\n')
	).toThrow("Unsupported gateway config field at root: providers");
	expect(() => parseGatewayConfigPatch("[routing]\nmodel_map = {}\n")).toThrow(
		"Unsupported gateway config field at routing: model_map"
	);
});

test("Gateway diff uses active values, reports only changed fields, and redacts API keys", () => {
	const patch = parseGatewayConfigPatch(SOURCE);
	const changes = gatewayConfigDiff(patch, {
		firewall: { enabled: false, policy: "block" },
		budgets: { session: { limit: 1_000_000, action: "stop" } },
		auth: {
			require_auth: false,
			api_keys: [{ name: "ci", key: "old-secret", trusted_forwarder: false }],
		},
	});
	expect(changes).toEqual([
		{ path: "firewall.enabled", before: false, after: true },
		{ path: "firewall.policy", before: "block", after: "sanitize" },
		{ path: "auth.require_auth", before: false, after: true },
		{
			path: "auth.api_keys",
			before: [{ name: "ci", key: "[redacted]", trusted_forwarder: false }],
			after: [{ name: "ci", key: "[redacted]", trusted_forwarder: false }],
		},
	]);
});

test("ryu apply reads TOML and sends the exact Core patch only after validation", async () => {
	const path = configFile(SOURCE);
	const captured: Array<{ method?: string; path: string; body?: unknown }> = [];
	const api = stubApi({
		call: async (_target, route, options) => {
			captured.push({ path: route, ...options });
			return {
				ok: true,
				externally_managed: false,
				effective_config: {
					auth: { api_keys: [{ name: "ci", key: "secret-token" }] },
				},
			};
		},
	});
	const cap = captureIo();
	const code = await runCli(["apply", "-f", path, "--json"], {
		api,
		io: cap.io,
	});
	expect(code).toBe(0);
	expect(captured).toEqual([
		{
			path: "/api/gateway/config",
			method: "PUT",
			body: {
				firewall: { enabled: true, policy: "sanitize" },
				budgets: { session: { limit: 1_000_000, action: "stop" } },
				auth: {
					require_auth: true,
					api_keys: [
						{ name: "ci", key: "secret-token", trusted_forwarder: false },
					],
				},
			},
		},
	]);
	expect(JSON.parse(cap.out())).toEqual({
		ok: true,
		externally_managed: false,
		effective_config: {
			auth: { api_keys: [{ name: "ci", key: "[redacted]" }] },
		},
	});
	expect(cap.out()).not.toContain("secret-token");
	// Applying never rewrites the source file or replaces its comments/formatting.
	expect(readFileSync(path, "utf8")).toBe(SOURCE);
});

test("ryu apply --dry-run validates and redacts without making a Core write", async () => {
	const path = configFile(SOURCE);
	let coreCalls = 0;
	const cap = captureIo();
	const code = await runCli(["apply", "-f", path, "--dry-run", "--json"], {
		io: cap.io,
		api: stubApi({
			call: async () => {
				coreCalls += 1;
				return {};
			},
		}),
	});
	expect(code).toBe(0);
	expect(coreCalls).toBe(0);
	const output = cap.out();
	expect(output).toContain("[redacted]");
	expect(output).not.toContain("secret-token");
	expect(JSON.parse(output)).toMatchObject({ dryRun: true });
});

test("ryu diff compares the file with Gateway GET without mutating config", async () => {
	const path = configFile(SOURCE);
	const captured: Array<{ method?: string; path: string }> = [];
	const cap = captureIo();
	const code = await runCli(["diff", "-f", path, "--json"], {
		io: cap.io,
		api: stubApi({
			call: async (_target, route, options) => {
				captured.push({ path: route, method: options?.method });
				return {
					firewall: { enabled: false, policy: "block" },
					budgets: { session: { limit: 1_000_000, action: "stop" } },
					auth: {
						require_auth: false,
						api_keys: [
							{ name: "ci", key: "live-secret", trusted_forwarder: false },
						],
					},
				};
			},
		}),
	});
	expect(code).toBe(0);
	expect(captured).toEqual([{ path: "/api/gateway/config", method: "GET" }]);
	const output = cap.out();
	expect(output).toContain("firewall.enabled");
	expect(output).toContain("auth.require_auth");
	expect(output).not.toContain("secret-token");
	expect(output).not.toContain("live-secret");
});

test("ryu config show reads current state; unsupported revision commands fail with usage", async () => {
	const cap = captureIo();
	const captured: Array<{ method?: string; path: string }> = [];
	const api = stubApi({
		call: async (_target, route, options) => {
			captured.push({ path: route, method: options?.method });
			return {
				firewall: { enabled: true },
				auth: { api_keys: [{ name: "ci", key: "stored-secret" }] },
			};
		},
	});
	expect(await runCli(["config"], { api, io: cap.io })).toBe(0);
	expect(await runCli(["config", "show"], { api, io: cap.io })).toBe(0);
	expect(captured).toEqual([
		{ path: "/api/gateway/config", method: "GET" },
		{ path: "/api/gateway/config", method: "GET" },
	]);
	expect(cap.out()).toContain("[redacted]");
	expect(cap.out()).not.toContain("stored-secret");
	const invalid = captureIo();
	expect(await runCli(["config", "revisions"], { api, io: invalid.io })).toBe(
		2
	);
	expect(invalid.err()).toContain("Usage: ryu-cli config [show]");
});
