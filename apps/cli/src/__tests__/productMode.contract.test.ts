import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { ApiError, type ApiTarget } from "@ryuhq/core-client/client";
import { authBackendUrl } from "../core/controlPlane.ts";
import type { Node } from "../core/nodes.ts";
import {
	activateProductMode,
	defaultProductModePreference,
	isKnownUnmanagedTarget,
	type ProductModeRequest,
	parseProductModePreference,
	productModePreferencePath,
	readProductModePreference,
	resolveStartupProductMode,
	withProductMode,
	withStartupRealm,
	writeProductModePreference,
} from "../core/productMode.ts";

const LOCAL_TARGET: ApiTarget = { url: "http://127.0.0.1:2049", token: null };
const MANAGED_TARGET: ApiTarget = {
	url: "https://core.managed.example",
	token: null,
	userJwt: "short-lived-scoped-delegation",
};
const AUTH_URL = authBackendUrl();
const PERMISSIONS_PATH = "/api/control-plane/me/permissions?orgId=org-1";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function temporaryFilePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "ryu-cli-mode-contract-"));
	temporaryDirectories.push(directory);
	return join(directory, ".ryu", "cli-product-mode.json");
}

function managedNode(overrides: Partial<Node> = {}): Node {
	return {
		name: "cloud-workspace",
		url: MANAGED_TARGET.url,
		token: null,
		userJwt: MANAGED_TARGET.userJwt,
		managed: true,
		orgId: "org-1",
		...overrides,
	};
}

interface PersistedCloudPreference {
	value: string | null;
}

interface ProductModeRequestCall {
	method: string;
	path: string;
	target: ApiTarget;
}

function requestRecorder(handler: ProductModeRequest) {
	const calls: ProductModeRequestCall[] = [];
	const request: ProductModeRequest = async (target, path, options) => {
		calls.push({
			method: options?.method ?? "GET",
			path,
			target,
		});
		return handler(target, path, options);
	};
	return { calls, request };
}

const defaultPreference = defaultProductModePreference();

describe("CLI product-mode contract", () => {
	test("new profiles default to Bot and reject unsafe persisted surface paths", () => {
		expect(defaultPreference.mode).toBe("bot");
		expect(defaultPreference.surfaces).toEqual({
			bot: "/chat",
			console: "/home",
			os: "/app-launcher",
		});

		expect(
			parseProductModePreference({
				mode: "unknown",
				surfaces: {
					bot: "../settings",
					console: "https://outside.example",
					os: "/app-launcher",
				},
			})
		).toEqual(defaultPreference);
		expect(
			parseProductModePreference({ mode: "os", surfaces: {} }).startupRealm
		).toBe("last-used");
		expect(
			parseProductModePreference({
				mode: "os",
				startupRealm: "unsupported",
				surfaces: {},
			}).startupRealm
		).toBe("last-used");
	});

	test("startup realm is independently persisted and resolves Last used against the saved mode", () => {
		const filePath = temporaryFilePath();
		const osOnLaunch = withStartupRealm(defaultPreference, "os");
		writeProductModePreference(osOnLaunch, filePath);

		expect(readProductModePreference(filePath)).toEqual({
			...defaultPreference,
			startupRealm: "os",
		});
		expect(resolveStartupProductMode(readProductModePreference(filePath))).toBe(
			"os"
		);
		expect(
			resolveStartupProductMode(
				withStartupRealm(
					withProductMode(defaultPreference, "console"),
					"last-used"
				)
			)
		).toBe("console");
	});

	test("mode selection remembers the chosen per-mode landing surface on disk", () => {
		const filePath = temporaryFilePath();
		const preference = withProductMode(defaultPreference, "os", "/library");
		writeProductModePreference(preference, filePath);

		expect(readProductModePreference(filePath)).toEqual({
			...defaultPreference,
			mode: "os",
			surfaces: { ...defaultPreference.surfaces, os: "/library" },
		});
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
			mode: "os",
			version: 1,
		});
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		expect(productModePreferencePath("/profiles/demo", {})).toBe(
			join("/profiles/demo", ".ryu", "state", "cli", "cli-product-mode.json")
		);
	});

	test("only local or explicitly configured targets are unmanaged", () => {
		expect(isKnownUnmanagedTarget(LOCAL_TARGET)).toBe(true);
		expect(
			isKnownUnmanagedTarget(
				{ url: "https://lan-core.example", token: "local-token" },
				["https://lan-core.example/"]
			)
		).toBe(true);
		expect(isKnownUnmanagedTarget(MANAGED_TARGET, [MANAGED_TARGET.url])).toBe(
			false
		);
		expect(
			isKnownUnmanagedTarget({
				url: "https://unknown-core.example",
				token: null,
			})
		).toBe(false);
	});

	test("OS mode opens the terminal App Launcher without account or Core calls", async () => {
		const { calls, request } = requestRecorder(async () => {
			throw new Error("OS mode must not require auth or Core access checks");
		});
		const result = await activateProductMode("os", {
			activeTarget: MANAGED_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: false,
			preference: defaultPreference,
			request,
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode: "os",
			ok: true,
			surface: "/app-launcher",
			target: MANAGED_TARGET,
		});
		expect(calls).toEqual([]);
	});

	test("Bot remains selectable when signed out and keeps the current chat target", async () => {
		const { calls, request } = requestRecorder(async () => ({
			authenticated: false,
			token: null,
		}));
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => {
				throw new Error("must not fetch managed nodes while signed out");
			},
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "subscription-required",
			mode: "bot",
			notice: { kind: "subscription-required" },
			ok: true,
			surface: "/chat",
			target: LOCAL_TARGET,
		});
		expect(calls.map((call) => call.path)).toEqual(["/api/auth/status"]);
	});

	test("Bot keeps the local workspace when managed inference is not entitled", async () => {
		const { calls, request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (
				target.url === AUTH_URL &&
				path === "/api/billing/subscription-status"
			) {
				return { entitlement: { managedInference: false } };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => {
				throw new Error("must not fetch managed nodes without entitlement");
			},
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "subscription-required",
			mode: "bot",
			notice: { kind: "subscription-required" },
			ok: true,
			target: LOCAL_TARGET,
		});
		expect(calls.map((call) => call.path)).toEqual([
			"/api/auth/status",
			"/api/billing/subscription-status",
		]);
	});

	test("Bot seeds only an empty managed cloud lane and keeps scoped credentials in memory", async () => {
		const writes: { body: unknown; target: ApiTarget }[] = [];
		let persistedSelection = "";
		const { request } = requestRecorder(async (target, path, options) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (
				target.url === AUTH_URL &&
				path === "/api/billing/subscription-status"
			) {
				return { entitlement: { managedInference: true } };
			}
			if (
				target.url === MANAGED_TARGET.url &&
				path === "/api/preferences/default-cloud-agent-selection"
			) {
				if (options?.method === "PUT") {
					writes.push({ body: options.body, target });
					if (!isNativeObjectLike(options.body) || options.body === null) {
						throw new Error("Expected a string preference value");
					}
					// SAFETY: The native object-like observer above excludes primitives,
					// functions and null. This alias keeps the original raw object for `in`.
					// The actual product-mode PUT publisher owns an ordinary { value } body.
					const rawBody = options.body as object;
					if (!("value" in rawBody && isNativeText(rawBody.value))) {
						throw new Error("Expected a string preference value");
					}
					persistedSelection = rawBody.value;
					return { ok: true };
				}
				return { value: persistedSelection };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result).toMatchObject({
			cloudLane: "seeded",
			managedAccess: "available",
			mode: "bot",
			ok: true,
			surface: "/chat",
			target: MANAGED_TARGET,
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]?.target).toEqual(MANAGED_TARGET);
		expect(writes[0]?.body).toEqual({
			value: JSON.stringify({
				access_mode: "",
				agent_id: "ryu",
				effort: "",
				model: "openrouter/auto",
				provider: "managed-openrouter",
				thinking_level: "",
			}),
		});
	});

	test("Bot seeds a missing 404 cloud preference and confirms the exact stored selection", async () => {
		const persistedSelection: PersistedCloudPreference = { value: null };
		const { calls, request } = requestRecorder(
			async (target, path, options) => {
				if (path === "/api/auth/status") {
					return { authenticated: true, token: "account-session" };
				}
				if (
					target.url === AUTH_URL &&
					path === "/api/billing/subscription-status"
				) {
					return { entitlement: { managedInference: true } };
				}
				if (
					target.url === MANAGED_TARGET.url &&
					path === "/api/preferences/default-cloud-agent-selection"
				) {
					if (options?.method === "PUT") {
						if (!isNativeObjectLike(options.body) || options.body === null) {
							throw new Error("Expected a string preference value");
						}
						// SAFETY: The native object-like observer above excludes primitives,
						// functions and null. This alias keeps the original raw object for `in`.
						// The actual product-mode PUT publisher owns an ordinary { value } body.
						const rawBody = options.body as object;
						if (!("value" in rawBody && isNativeText(rawBody.value))) {
							throw new Error("Expected a string preference value");
						}
						persistedSelection.value = rawBody.value;
						return { ok: true };
					}
					if (persistedSelection.value === null) {
						throw new ApiError(path, 404, "preference not found");
					}
					return { value: persistedSelection.value };
				}
				throw new Error(`unexpected request: ${target.url}${path}`);
			}
		);
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});
		expect(result).toMatchObject({
			cloudLane: "seeded",
			managedAccess: "available",
			ok: true,
			target: MANAGED_TARGET,
		});
		expect(persistedSelection.value).toBe(
			JSON.stringify({
				access_mode: "",
				agent_id: "ryu",
				effort: "",
				model: "openrouter/auto",
				provider: "managed-openrouter",
				thinking_level: "",
			})
		);
		expect(
			calls.filter(
				(call) => call.path === "/api/preferences/default-cloud-agent-selection"
			)
		).toEqual([
			{
				method: "GET",
				path: "/api/preferences/default-cloud-agent-selection",
				target: MANAGED_TARGET,
			},
			{
				method: "PUT",
				path: "/api/preferences/default-cloud-agent-selection",
				target: MANAGED_TARGET,
			},
			{
				method: "GET",
				path: "/api/preferences/default-cloud-agent-selection",
				target: MANAGED_TARGET,
			},
		]);
	});

	test("Bot preserves an existing provider/model selection instead of overwriting it", async () => {
		const writes: unknown[] = [];
		const { request } = requestRecorder(async (target, path, options) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (
				target.url === AUTH_URL &&
				path === "/api/billing/subscription-status"
			) {
				return { entitlement: { managedInference: true } };
			}
			if (path === "/api/preferences/default-cloud-agent-selection") {
				if (options?.method === "PUT") {
					writes.push(options.body);
				}
				return {
					value: JSON.stringify({ provider: "customer", model: "chosen" }),
				};
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result.ok && result.cloudLane).toBe("preserved");
		expect(writes).toEqual([]);
	});

	test("Bot reports a failed default-lane write while keeping managed chat usable", async () => {
		const writes: { method: string; target: ApiTarget }[] = [];
		const { request } = requestRecorder(async (target, path, options) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (
				target.url === AUTH_URL &&
				path === "/api/billing/subscription-status"
			) {
				return { entitlement: { managedInference: true } };
			}
			if (
				target.url === MANAGED_TARGET.url &&
				path === "/api/preferences/default-cloud-agent-selection"
			) {
				if (options?.method === "PUT") {
					writes.push({ method: options.method, target });
					throw new Error("Preference service unavailable");
				}
				return { value: "" };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result).toMatchObject({
			cloudLane: "unavailable",
			managedAccess: "available",
			mode: "bot",
			notice: { kind: "cloud-lane-write-failed" },
			ok: true,
			target: MANAGED_TARGET,
		});
		expect(writes).toEqual([{ method: "PUT", target: MANAGED_TARGET }]);
	});

	test("Bot does not switch nodes before a managed workspace is ready", async () => {
		const { request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (
				target.url === AUTH_URL &&
				path === "/api/billing/subscription-status"
			) {
				return { entitlement: { managedInference: true } };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("bot", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [],
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "workspace-pending",
			mode: "bot",
			notice: { kind: "managed-workspace-pending" },
			ok: true,
			target: LOCAL_TARGET,
		});
	});

	test("Console is available on a known unmanaged node without account authority", async () => {
		const { calls, request } = requestRecorder(async () => {
			throw new Error("unmanaged Console must not query the control plane");
		});
		const result = await activateProductMode("console", {
			activeTarget: LOCAL_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: true,
			preference: defaultPreference,
			request,
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode: "console",
			ok: true,
			surface: "/home",
			target: LOCAL_TARGET,
		});
		expect(calls).toEqual([]);
	});

	test.each([
		[
			"built-in owner/admin",
			["gateway.view", "gateway.configure", "agent.run"],
		],
		["custom role", ["agent.run", "gateway.configure"]],
	] as const)("Console allows a managed-node %s with Gateway configuration and keeps its scoped target", async (_label, permissions) => {
		const { request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (target.url === AUTH_URL && path === PERMISSIONS_PATH) {
				return { permissions };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("console", {
			activeTarget: MANAGED_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: false,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result).toMatchObject({
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode: "console",
			ok: true,
			surface: "/home",
			target: MANAGED_TARGET,
		});
	});

	test("Console fails closed for a managed-node member without Gateway configuration and leaves the target untouched", async () => {
		const { request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (target.url === AUTH_URL && path === PERMISSIONS_PATH) {
				return { permissions: ["gateway.view", "agent.run", "space.write"] };
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("console", {
			activeTarget: MANAGED_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: false,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result).toMatchObject({
			issue: { kind: "console-denied" },
			ok: false,
		});
	});

	test("Console treats a control-plane 403 as a non-member and denies it", async () => {
		const { request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			if (target.url === AUTH_URL && path === PERMISSIONS_PATH) {
				throw new ApiError(path, 403, "not a member of this org");
			}
			throw new Error(`unexpected request: ${target.url}${path}`);
		});
		const result = await activateProductMode("console", {
			activeTarget: MANAGED_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: false,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => [managedNode()],
		});

		expect(result).toMatchObject({
			issue: { kind: "console-denied" },
			ok: false,
		});
	});

	test("Console fails closed when managed-node role verification is unavailable", async () => {
		const { request } = requestRecorder(async (target, path) => {
			if (path === "/api/auth/status") {
				return { authenticated: true, token: "account-session" };
			}
			throw new Error(`offline at ${target.url}${path}`);
		});
		const result = await activateProductMode("console", {
			activeTarget: MANAGED_TARGET,
			authSourceTarget: LOCAL_TARGET,
			knownUnmanagedTarget: false,
			preference: defaultPreference,
			request,
			fetchManagedNodes: async () => null,
		});

		expect(result).toMatchObject({
			issue: { kind: "control-plane-unavailable" },
			ok: false,
		});
	});
});
