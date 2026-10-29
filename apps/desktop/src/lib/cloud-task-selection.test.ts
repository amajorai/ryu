import { describe, expect, test } from "bun:test";
import {
	BOX_BACKEND_DISABLED_REASON,
	CLOUD_EXECUTOR_LABELS,
	type CloudTaskSelection,
	cloudTaskBlockReason,
	cloudTaskRequestFields,
	cloudTaskScope,
	managedCloudExecutor,
	runtimeFromBinding,
	useCloudTaskSelections,
} from "./cloud-task-selection.ts";

describe("cloud task selection", () => {
	test("scope separates nodes, accounts and chats without storing raw credentials", async () => {
		const base = {
			url: "https://node.example",
			token: "node-secret",
			userJwt: "user-identity",
		};
		const scope = await cloudTaskScope(base, "chat-a");
		expect(scope).toMatch(/^[a-f0-9]{64}$/);
		expect(scope).not.toContain(base.token);
		expect(await cloudTaskScope(base, "chat-b")).not.toBe(scope);
		expect(
			await cloudTaskScope({ ...base, userJwt: "another-account" }, "chat-a")
		).not.toBe(scope);
		expect(
			await cloudTaskScope(
				{ ...base, url: "https://other-node.example" },
				"chat-a"
			)
		).not.toBe(scope);
	});
	test("empty cloud mode cannot send or fall back to local execution", () => {
		const selection = {
			mode: "cloud",
			environmentId: null,
			runtime: null,
			locked: false,
		} as const;
		expect(cloudTaskBlockReason(selection, "ryu")).toContain(
			"Choose a published"
		);
		expect(() => cloudTaskRequestFields(selection, "ryu")).toThrow();
	});
	test("native request contains only the opaque environment ID", () => {
		expect(
			cloudTaskRequestFields(
				{
					mode: "cloud",
					environmentId: "profile-a",
					runtime: null,
					locked: true,
				},
				"ryu"
			)
		).toEqual({ cloudEnvironmentId: "profile-a" });
		expect(cloudTaskRequestFields({ mode: "local", locked: false })).toEqual(
			{}
		);
		expect(() =>
			cloudTaskRequestFields(
				{
					mode: "cloud",
					environmentId: "profile-a",
					runtime: null,
					locked: false,
				},
				"custom-acp"
			)
		).toThrow("Ryu native agent");
	});
	test("a submitted chat cannot switch clouds or become local", () => {
		const store = useCloudTaskSelections.getState();
		store.setSelection("immutable-test", {
			mode: "cloud",
			environmentId: "profile-a",
			runtime: { backend: "box", executor: "codex" },
			locked: true,
		});
		store.setSelection("immutable-test", { mode: "local", locked: false });
		store.setSelection("immutable-test", {
			mode: "cloud",
			environmentId: "profile-b",
			runtime: null,
			locked: false,
		});
		expect(
			useCloudTaskSelections.getState().selections["immutable-test"]
		).toEqual({
			mode: "cloud",
			environmentId: "profile-a",
			runtime: { backend: "box", executor: "codex" },
			locked: true,
		});
	});
});

const BOX_ON = { boxBackendEnabled: true } as const;

describe("managed cloud executors", () => {
	const cloud = (
		runtime: Extract<CloudTaskSelection, { mode: "cloud" }>["runtime"]
	): CloudTaskSelection => ({
		mode: "cloud",
		environmentId: "profile-a",
		runtime,
		locked: false,
	});
	test("the Ryu agent rule is skipped only for a managed executor", () => {
		expect(
			cloudTaskBlockReason(
				cloud({ backend: "box", executor: "codex" }),
				"custom-acp",
				BOX_ON
			)
		).toBeNull();
		expect(
			cloudTaskBlockReason(
				cloud({ backend: "box", executor: "ryu" }),
				"custom-acp",
				BOX_ON
			)
		).toContain("Select Ryu");
		expect(cloudTaskBlockReason(cloud(null), "custom-acp", BOX_ON)).toContain(
			"Select Ryu"
		);
		expect(
			cloudTaskBlockReason(
				{
					mode: "cloud",
					environmentId: null,
					runtime: { backend: "box", executor: "codex" },
					locked: false,
				},
				"custom-acp",
				BOX_ON
			)
		).toContain("Choose a published");
		expect(
			cloudTaskRequestFields(
				cloud({ backend: "box", executor: "codex" }),
				"custom-acp",
				BOX_ON
			)
		).toEqual({ cloudEnvironmentId: "profile-a" });
	});
	test("managedCloudExecutor is null for local, Ryu and an unknown runtime", () => {
		expect(
			managedCloudExecutor({ mode: "local", locked: false }, BOX_ON)
		).toBeNull();
		expect(managedCloudExecutor({ mode: "loading" }, BOX_ON)).toBeNull();
		expect(managedCloudExecutor(cloud(null), BOX_ON)).toBeNull();
		expect(
			managedCloudExecutor(cloud({ backend: "box", executor: "ryu" }), BOX_ON)
		).toBeNull();
		expect(
			managedCloudExecutor(
				cloud({ backend: "box", executor: "claude-code" }),
				BOX_ON
			)
		).toBe("claude-code");
	});
	test("runtimeFromBinding accepts only known executors", () => {
		expect(runtimeFromBinding("box", "opencode")).toEqual({
			backend: "box",
			executor: "opencode",
		});
		expect(runtimeFromBinding("docker", "ryu")).toEqual({
			backend: "auto",
			executor: "ryu",
		});
		expect(runtimeFromBinding("box", "devin")).toBeNull();
		expect(runtimeFromBinding("box", "toString")).toBeNull();
		expect(runtimeFromBinding(undefined, undefined)).toBeNull();
		expect(runtimeFromBinding(null, null)).toBeNull();
	});
	test("executor labels match the product names", () => {
		expect(CLOUD_EXECUTOR_LABELS).toEqual({
			ryu: "Ryu",
			"claude-code": "Claude Code",
			codex: "Codex",
			opencode: "OpenCode",
			cursor: "Cursor",
		});
	});
});

describe("Fresh cloud box rollout flag off", () => {
	const boxCodex: CloudTaskSelection = {
		mode: "cloud",
		environmentId: "profile-a",
		runtime: { backend: "box", executor: "codex" },
		locked: false,
	};
	test("a box selection is blocked when the flag is off or never read", () => {
		expect(
			cloudTaskBlockReason(boxCodex, "ryu", { boxBackendEnabled: false })
		).toBe(BOX_BACKEND_DISABLED_REASON);
		expect(cloudTaskBlockReason(boxCodex, "ryu")).toBe(
			BOX_BACKEND_DISABLED_REASON
		);
		expect(() =>
			cloudTaskRequestFields(boxCodex, "ryu", { boxBackendEnabled: false })
		).toThrow(BOX_BACKEND_DISABLED_REASON);
	});
	test("an automatic-backend selection is unaffected", () => {
		const auto: CloudTaskSelection = {
			mode: "cloud",
			environmentId: "profile-a",
			runtime: { backend: "auto", executor: "ryu" },
			locked: false,
		};
		expect(
			cloudTaskBlockReason(auto, "ryu", { boxBackendEnabled: false })
		).toBeNull();
		expect(
			cloudTaskRequestFields(auto, "ryu", { boxBackendEnabled: false })
		).toEqual({ cloudEnvironmentId: "profile-a" });
		expect(
			cloudTaskRequestFields({ mode: "local", locked: false }, "custom-acp", {
				boxBackendEnabled: false,
			})
		).toEqual({});
	});
	test("a non-Ryu agent is blocked even with a managed executor", () => {
		const autoManaged: CloudTaskSelection = {
			mode: "cloud",
			environmentId: "profile-a",
			runtime: { backend: "auto", executor: "codex" },
			locked: false,
		};
		expect(managedCloudExecutor(autoManaged)).toBeNull();
		expect(managedCloudExecutor(boxCodex)).toBeNull();
		expect(
			cloudTaskBlockReason(autoManaged, "custom-acp", {
				boxBackendEnabled: false,
			})
		).toContain("Select Ryu");
	});
});
