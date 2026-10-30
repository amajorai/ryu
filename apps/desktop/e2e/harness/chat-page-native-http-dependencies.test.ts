import { expect, test } from "bun:test";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";

function persisted() {
	const values = new Map<string, string>();
	return {
		getItem: (k: string) => values.get(k) ?? null,
		setItem: (k: string, v: string) => {
			values.set(k, v);
		},
	};
}
test("finite native dependency contracts match scalar and editor DTOs, refuse all unknown commands/arguments, and retain tab revisions", () => {
	const native = createChatPageNativeDependencies(persisted());
	expect(native.invoke("plugin:deep-link|get_current")).toEqual({
		handled: true,
		value: null,
	});
	expect(native.invoke("agent_browser_stream_status").value).toEqual({
		connected: false,
		enabled: false,
		port: null,
		screencasting: false,
	});
	expect(native.invoke("get_build_profile").value).toEqual({
		dev: false,
		profile: "release",
		deepLinkProfile: null,
	});
	expect(native.invoke("due_app_update").value).toBeNull();
	expect(native.invoke("is_fullscreen").value).toBe(false);
	expect(
		native.invoke("get_editor_availability", {
			editors: ["vscode", "explorer"],
		}).value
	).toEqual([
		{ id: "vscode", available: false },
		{ id: "explorer", available: true },
	]);
	expect(native.invoke("not-a-real-success-placeholder").handled).toBe(false);
	expect(() =>
		native.invoke("plugin:app|version", { foreign: true })
	).toThrow();
	expect(() =>
		native.invoke("get_editor_availability", { editors: ["arbitrary-script"] })
	).toThrow();
	const tabs = [
		{ active: true, key: "conversation:conversation-toolbar-share-fixture" },
	];
	expect(
		native.invoke("register_window_tabs", {
			rendererId: "owned-main",
			revision: 2,
			tabs,
		}).value
	).toBeNull();
	native.invoke("register_window_tabs", {
		rendererId: "owned-main",
		revision: 1,
		tabs: [],
	});
	expect(native.snapshot().windowTabs).toEqual({
		"owned-main": { revision: 2, tabs },
	});
	expect(() =>
		native.invoke("register_window_tabs", {
			rendererId: "owned-main",
			revision: 3,
			tabs: [{ active: true, key: "conversation:foreign" }],
		})
	).toThrow();
	expect(native.snapshot().windowTabs).toEqual({
		"owned-main": { revision: 2, tabs },
	});
});
test("a tab bound to the second computer registers under that computer's name, and any other computer or conversation is refused", () => {
	const native = createChatPageNativeDependencies(persisted(), {
		acceptNewChats: true,
	});
	const bound = [
		{
			active: true,
			key: "conversation:Native%20HTTP%20B:conversation-toolbar-share-fixture",
		},
		{ active: false, key: "conversation:Native%20HTTP%20B:conv-1792254171170" },
	];
	expect(
		native.invoke("register_window_tabs", {
			rendererId: "owned-main",
			revision: 1,
			tabs: bound,
		}).value
	).toBeNull();
	expect(native.snapshot().windowTabs).toEqual({
		"owned-main": { revision: 1, tabs: bound },
	});
	for (const key of [
		"conversation:Other%20Computer:conversation-toolbar-share-fixture",
		"conversation:Native%20HTTP%20B:conversation-foreign",
		"conversation:Native%20HTTP%20B:conv-abc",
	]) {
		expect(() =>
			native.invoke("register_window_tabs", {
				rendererId: "owned-main",
				revision: 2,
				tabs: [{ active: true, key }],
			})
		).toThrow("Invalid owned conversation tab");
	}
	expect(native.snapshot().windowTabs).toEqual({
		"owned-main": { revision: 1, tabs: bound },
	});
});

test("installed Tauri store/app/deep-link SDK consumes exact finite IPC and explicit save survives a fresh bridge, without leaking sibling store fields", async () => {
	const storage = persisted();
	let native = createChatPageNativeDependencies(storage);
	const calls: Array<{ command: string; args: unknown }> = [];
	const old = Reflect.get(globalThis, "window");
	const window = {
		__TAURI_INTERNALS__: {
			invoke: async (command: string, args?: Record<string, unknown>) => {
				calls.push({ command, args });
				const result = native.invoke(command, args);
				if (!result.handled) {
					throw new Error(`Unknown SDK command ${command}`);
				}
				return result.value;
			},
		},
	};
	Reflect.set(globalThis, "window", window);
	try {
		const Store = await import("@tauri-apps/plugin-store");
		const app = await import("@tauri-apps/api/app");
		const deepLink = await import("@tauri-apps/plugin-deep-link");
		expect(await app.getName()).toBe("Ryu");
		expect(await app.getVersion()).toBe("0.0.0");
		expect(await deepLink.getCurrent()).toBeNull();
		const entitlement = await Store.load("entitlement.bin");
		expect(await entitlement.get("firstLaunchAtMs")).toBeUndefined();
		await entitlement.set("firstLaunchAtMs", 1_790_812_800_000);
		const unsaved = createChatPageNativeDependencies(storage);
		const rid = unsaved.invoke("plugin:store|load", {
			path: "entitlement.bin",
		}).value;
		expect(
			unsaved.invoke("plugin:store|get", { rid, key: "firstLaunchAtMs" }).value
		).toEqual([null, false]);
		await entitlement.save();
		native = createChatPageNativeDependencies(storage);
		const reloaded = await Store.load("entitlement.bin");
		expect(await reloaded.get<number>("firstLaunchAtMs")).toBe(
			1_790_812_800_000
		);
		const companion = await Store.load("companion.bin");
		expect(await companion.get("companion_paused")).toBeUndefined();
		await companion.set("companion_paused", true);
		await companion.save();
		expect(await reloaded.get<number>("firstLaunchAtMs")).toBe(
			1_790_812_800_000
		);
		const auth = await Store.load("auth.bin");
		expect(await auth.get("accounts")).toBeUndefined();
		await auth.set("accounts", [
			{ userId: "owned-user", token: "owned-token" },
		]);
		await auth.set("activeUserId", "owned-user");
		await auth.set("token", "owned-token");
		expect(await auth.delete("token")).toBe(true);
		expect(await auth.delete("token")).toBe(false);
		await auth.save();
		native = createChatPageNativeDependencies(storage);
		const restoredAuth = await Store.load("auth.bin");
		expect(await restoredAuth.get<string>("activeUserId")).toBe("owned-user");
		expect(
			await restoredAuth.get<Array<{ token: string; userId: string }>>(
				"accounts"
			)
		).toEqual([{ userId: "owned-user", token: "owned-token" }]);
		expect(await restoredAuth.get("token")).toBeUndefined();
		await expect(restoredAuth.delete("foreign-key")).rejects.toThrow(
			"Unknown owned store key"
		);
		expect(calls).toContainEqual({
			command: "plugin:store|load",
			args: { path: "entitlement.bin", options: undefined },
		});
		await expect(Store.load("foreign.bin")).rejects.toThrow(
			"Unknown owned store"
		);
		await expect(reloaded.get("foreign-key")).rejects.toThrow(
			"Unknown owned store key"
		);
		expect(() =>
			native.invoke("plugin:store|get", { rid: 99_999, key: "licenseKey" })
		).toThrow("Unknown owned store handle");
	} finally {
		if (old === undefined) {
			Reflect.deleteProperty(globalThis, "window");
		} else {
			Reflect.set(globalThis, "window", old);
		}
	}
});
test("route_entity_open mirrors the single-window registry decision and refuses empty or foreign entities", () => {
	const native = createChatPageNativeDependencies(persisted());
	const original = "conversation:conversation-toolbar-share-fixture";
	const earlier = "conversation:conversation-earlier-thread-fixture";
	// Nothing registered yet: the renderer opens it locally.
	expect(
		native.invoke("route_entity_open", { key: original, messageId: undefined })
			.value
	).toEqual({ action: "createCurrent", windowLabel: null });
	native.invoke("register_window_tabs", {
		rendererId: "renderer-a",
		revision: 1,
		tabs: [{ active: true, key: original }],
	});
	expect(
		native.invoke("route_entity_open", { key: original, messageId: "m-1" })
			.value
	).toEqual({ action: "current", windowLabel: "main" });
	expect(native.invoke("route_entity_open", { key: earlier }).value).toEqual({
		action: "createCurrent",
		windowLabel: null,
	});
	// A reloaded renderer replaces the window's record, as the Rust registry
	// keys records by window label.
	native.invoke("register_window_tabs", {
		rendererId: "renderer-b",
		revision: 0,
		tabs: [{ active: true, key: earlier }],
	});
	expect(native.invoke("route_entity_open", { key: original }).value).toEqual({
		action: "createCurrent",
		windowLabel: null,
	});
	expect(native.invoke("route_entity_open", { key: earlier }).value).toEqual({
		action: "current",
		windowLabel: "main",
	});
	expect(() => native.invoke("route_entity_open", { key: "" })).toThrow(
		"entity key cannot be empty"
	);
	expect(() =>
		native.invoke("route_entity_open", { key: "conversation:foreign" })
	).toThrow();
	expect(() =>
		native.invoke("route_entity_open", { key: original, extra: true })
	).toThrow();
	expect(native.snapshot().entityRoutes).toEqual([
		{ action: "createCurrent", key: original },
		{ action: "current", key: original, messageId: "m-1" },
		{ action: "createCurrent", key: earlier },
		{ action: "createCurrent", key: original },
		{ action: "current", key: earlier },
	]);
});

test("the Changes pane's working-tree shell reads answer a clean owned workspace and refuse anything else", () => {
	const native = createChatPageNativeDependencies(persisted());
	const owned = "/tmp/ryu-chat-controls-project";
	for (const command of [
		"git log -n 50 --pretty=format:%H%x09%s",
		'git branch --format="%(refname:short)"',
		"git diff HEAD",
	]) {
		expect(
			native.invoke("shell_execute", { command, cwd: owned, shell: null })
		).toEqual({ handled: true, value: { code: 0, stderr: "", stdout: "" } });
	}
	for (const args of [
		{ command: "git diff HEAD", cwd: "/tmp/other", shell: null },
		{ command: "git diff HEAD", cwd: owned, shell: "bash" },
		{ command: "git status", cwd: owned, shell: null },
		{ command: "rm -rf .", cwd: owned, shell: null },
		{ command: "git diff HEAD", cwd: owned, shell: null, extra: true },
	]) {
		expect(() => native.invoke("shell_execute", args)).toThrow();
	}
});

test("the sealed auth-vault and license-key slots answer null when empty, survive a fresh bridge, and refuse any other slot", () => {
	const storage = persisted();
	let native = createChatPageNativeDependencies(storage);
	expect(native.invoke("desktop_secret_get", { name: "auth-vault" })).toEqual({
		handled: true,
		value: null,
	});
	expect(
		native.invoke("desktop_secret_set", {
			name: "auth-vault",
			value: '{"accounts":[],"activeUserId":null}',
		})
	).toEqual({ handled: true, value: null });
	native.invoke("desktop_secret_set", {
		name: "license-key",
		value: "owned-license",
	});
	native = createChatPageNativeDependencies(storage);
	expect(
		native.invoke("desktop_secret_get", { name: "auth-vault" }).value
	).toBe('{"accounts":[],"activeUserId":null}');
	native.invoke("desktop_secret_delete", { name: "auth-vault" });
	expect(
		native.invoke("desktop_secret_get", { name: "auth-vault" }).value
	).toBeNull();
	expect(
		native.invoke("desktop_secret_get", { name: "license-key" }).value
	).toBe("owned-license");
	expect(
		native.invoke("plugin:event|listen", {
			event: "desktop-secret-changed",
			handler: 1,
			target: { kind: "Any" },
		}).handled
	).toBe(true);
	expect(
		native.invoke("plugin:event|listen", { event: "foreign", handler: 1 })
			.handled
	).toBe(false);
	expect(() =>
		native.invoke("desktop_secret_get", { name: "foreign-slot" })
	).toThrow("Unknown secret slot");
	expect(() =>
		native.invoke("desktop_secret_set", { name: "auth-vault", value: 1 })
	).toThrow("Invalid secret slot request");
	expect(() =>
		native.invoke("desktop_secret_get", { name: "auth-vault", extra: true })
	).toThrow("Invalid secret slot request");
});

test("the safe-mode sentinel reads unarmed and the webview content key is a stable 32-byte key per allowlisted store", () => {
	const native = createChatPageNativeDependencies(persisted());
	expect(native.invoke("get_safe_mode_sentinel")).toEqual({
		handled: true,
		value: false,
	});
	const local = native.invoke("desktop_content_key", {
		store: "local-storage",
	}).value as { key: number[]; retired: number[][] };
	const collaboration = native.invoke("desktop_content_key", {
		store: "collaboration",
	}).value as { key: number[]; retired: number[][] };
	expect(local.key).toHaveLength(32);
	expect(local.retired).toEqual([]);
	expect(local.key.every((byte) => byte >= 0 && byte < 256)).toBe(true);
	expect(collaboration.key).not.toEqual(local.key);
	expect(
		createChatPageNativeDependencies(persisted()).invoke(
			"desktop_content_key",
			{ store: "local-storage" }
		).value
	).toEqual(local);
	expect(() =>
		native.invoke("desktop_content_key", { store: "other" })
	).toThrow();
	expect(() => native.invoke("desktop_content_key")).toThrow();
	expect(() =>
		native.invoke("get_safe_mode_sentinel", { enabled: true })
	).toThrow();
});
