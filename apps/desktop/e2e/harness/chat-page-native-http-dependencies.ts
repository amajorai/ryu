// Finite native dependency contracts for shipping Layout. No actual OS features
// are executed. Unknown commands, arguments, paths, handles and keys are refused.
import {
	answerDesktopSecretSlot,
	type SlotStorage,
} from "./desktop-secret-slots.ts";

export function createChatPageNativeDependencies(
	storage: SlotStorage,
	// A scenario in which a suggested task starts a NEW chat. The browser mints that
	// chat's id (`conv-<millis>`), so it cannot be listed in advance.
	options: { acceptNewChats?: boolean } = {}
) {
	const stores = new Map<
		number,
		{ path: string; values: Record<string, unknown> }
	>();
	const paths = {
		"auth.bin": ["accounts", "activeUserId", "token"],
		"entitlement.bin": ["firstLaunchAtMs", "lastGoodEntitlement", "licenseKey"],
		"companion.bin": [
			"companion_consent",
			"companion_app_allowlist",
			"companion_paused",
			"companion_frames",
			"shadow_history_retention_days",
		],
	} as const;
	const windowTabs = new Map<
		string,
		{ revision: number; tabs: Array<{ active: boolean; key: string }> }
	>();
	// One native window ("main"). Like `window_registry.rs`, the window's record
	// is its latest accepted renderer registration.
	let windowRenderer: string | null = null;
	// A tab on the default computer registers its conversation bare; a tab bound
	// to the second computer ("Native HTTP B" in the harness) registers it under
	// that computer's name, exactly as `conversationEntityKey` builds it.
	const ownedNodeSegments = ["", `${encodeURIComponent("Native HTTP B")}:`];
	const ownedConversationKeys = ownedNodeSegments.flatMap((segment) =>
		[
			"conversation-toolbar-share-fixture",
			"conversation-earlier-thread-fixture",
			"conversation-latest-thread-fixture",
			"conversation-forked-fixture",
		].map((id) => `conversation:${segment}${encodeURIComponent(id)}`)
	);
	const isOwnedConversationKey = (key: unknown) =>
		typeof key === "string" &&
		(ownedConversationKeys.includes(key) ||
			(options.acceptNewChats === true &&
				ownedNodeSegments.some((segment) =>
					new RegExp(`^conversation:${segment}conv-\\d+$`).test(key)
				)));
	const entityRoutes: Array<{
		action: "createCurrent" | "current";
		key: string;
		messageId?: string;
	}> = [];
	const workingTreeReads = [
		"git log -n 50 --pretty=format:%H%x09%s",
		'git branch --format="%(refname:short)"',
		"git diff HEAD",
	];
	const noArgs = (args: Record<string, unknown>) => {
		if (Object.keys(args).length) {
			throw new Error("Unexpected native dependency arguments");
		}
	};
	const keys = (args: Record<string, unknown>, expected: string[]) => {
		if (Object.keys(args).some((k) => !expected.includes(k))) {
			throw new Error("Unknown native dependency argument");
		}
	};
	function store(args: Record<string, unknown>) {
		const entry = stores.get(Number(args.rid));
		if (!entry || typeof args.rid !== "number") {
			throw new Error("Unknown owned store handle");
		}
		return entry;
	}
	return {
		snapshot: () => ({
			stores: [...stores.values()].map((s) => ({
				path: s.path,
				values: structuredClone(s.values),
			})),
			windowTabs: Object.fromEntries(windowTabs),
			entityRoutes: structuredClone(entityRoutes),
		}),
		invoke(command: string, args: Record<string, unknown> = {}) {
			// The sealed `auth-vault` / `license-key` slots and their change event.
			const slot = answerDesktopSecretSlot(storage, command, args);
			if (slot.handled) {
				return slot;
			}
			const idle: Record<string, unknown> = {
				"plugin:deep-link|get_current": null,
				agent_browser_stream_status: {
					connected: false,
					enabled: false,
					port: null,
					screencasting: false,
				},
				due_app_update: null,
				is_fullscreen: false,
				"plugin:app|name": "Ryu",
				"plugin:app|version": "0.0.0",
				get_build_profile: {
					dev: false,
					profile: "release",
					deepLinkProfile: null,
				},
				// `~/.ryu/safe-mode` is not armed on this fixture device.
				get_safe_mode_sentinel: false,
			};
			if (Object.hasOwn(idle, command)) {
				noArgs(args);
				return { handled: true, value: structuredClone(idle[command]) };
			}
			// `desktop_seal::webview_content_key`: the keychain-derived 32-byte key
			// of one allowlisted webview store, plus the keys of earlier desktop keys
			// (none on this fixture device). Stable per store, like the keychain key,
			// so a reload opens what the previous page sealed.
			if (command === "desktop_content_key") {
				keys(args, ["store"]);
				const index = ["collaboration", "local-storage"].indexOf(
					String(args.store)
				);
				if (index < 0) {
					throw new Error("Unknown webview content store");
				}
				return {
					handled: true,
					value: {
						key: Array.from(
							{ length: 32 },
							(_, byte) => (byte * 37 + index * 101 + 13) % 256
						),
						retired: [],
					},
				};
			}
			if (command === "get_editor_availability") {
				keys(args, ["editors"]);
				const ids = [
					"vscode",
					"cursor",
					"zed",
					"gitbash",
					"terminal",
					"explorer",
					"powershell",
					"cmd",
				];
				if (
					!(Array.isArray(args.editors) && args.editors.length) ||
					args.editors.some((id) => typeof id !== "string" || !ids.includes(id))
				) {
					throw new Error("Unknown owned editor probe");
				}
				return {
					handled: true,
					value: args.editors.map((id) => ({
						id,
						available: id === "explorer",
					})),
				};
			}
			if (command === "register_window_tabs") {
				keys(args, ["rendererId", "revision", "tabs"]);
				if (
					typeof args.rendererId !== "string" ||
					!args.rendererId ||
					typeof args.revision !== "number" ||
					!Number.isSafeInteger(args.revision) ||
					args.revision < 0 ||
					!Array.isArray(args.tabs)
				) {
					throw new Error("Invalid window tab registration");
				}
				for (const tab of args.tabs) {
					if (
						!tab ||
						typeof tab !== "object" ||
						Object.keys(tab).length !== 2 ||
						typeof tab.active !== "boolean" ||
						typeof tab.key !== "string" ||
						!isOwnedConversationKey(tab.key)
					) {
						throw new Error("Invalid owned conversation tab");
					}
				}
				const old = windowTabs.get(args.rendererId);
				if (!old || old.revision <= args.revision) {
					windowTabs.set(args.rendererId, {
						revision: args.revision,
						tabs: structuredClone(args.tabs),
					});
					windowRenderer = args.rendererId;
				}
				return { handled: true, value: null };
			}
			if (command === "route_entity_open") {
				keys(args, ["key", "messageId"]);
				if (typeof args.key !== "string" || !args.key) {
					throw new Error("entity key cannot be empty");
				}
				if (
					args.messageId !== undefined &&
					typeof args.messageId !== "string"
				) {
					throw new Error("Invalid entity activation message");
				}
				if (!isOwnedConversationKey(args.key)) {
					throw new Error("Invalid owned conversation entity");
				}
				// Single-window `decide`: a key claimed by this window is `current`;
				// an unclaimed key is `createCurrent`. No other window can own it.
				const claimed =
					windowRenderer !== null &&
					(windowTabs.get(windowRenderer)?.tabs ?? []).some(
						(tab) => tab.key === args.key
					);
				const action = claimed ? "current" : "createCurrent";
				entityRoutes.push({
					action,
					key: args.key,
					...(args.messageId === undefined
						? {}
						: { messageId: args.messageId }),
				});
				return {
					handled: true,
					value: { action, windowLabel: claimed ? "main" : null },
				};
			}
			if (command === "plugin:store|load") {
				keys(args, ["path", "options"]);
				if (
					typeof args.path !== "string" ||
					!Object.hasOwn(paths, args.path) ||
					args.options !== undefined
				) {
					throw new Error("Unknown owned store path or options");
				}
				const existing = [...stores.entries()].find(
					([, s]) => s.path === args.path
				);
				if (existing) {
					return { handled: true, value: existing[0] };
				}
				const rid = 2000 + stores.size + 1;
				const saved = storage.getItem(`chat-page-native-store:${args.path}`);
				const values = saved ? JSON.parse(saved) : {};
				stores.set(rid, { path: args.path, values });
				return { handled: true, value: rid };
			}
			if (
				command === "plugin:store|get" ||
				command === "plugin:store|set" ||
				command === "plugin:store|delete"
			) {
				keys(
					args,
					command.endsWith("|set") ? ["rid", "key", "value"] : ["rid", "key"]
				);
				const entry = store(args);
				if (
					typeof args.key !== "string" ||
					!(
						paths[entry.path as keyof typeof paths] as readonly string[]
					).includes(args.key)
				) {
					throw new Error("Unknown owned store key");
				}
				if (command.endsWith("|get")) {
					return {
						handled: true,
						value: [
							entry.values[args.key] ?? null,
							Object.hasOwn(entry.values, args.key),
						],
					};
				}
				if (command.endsWith("|delete")) {
					const existed = Object.hasOwn(entry.values, args.key);
					delete entry.values[args.key];
					return { handled: true, value: existed };
				}
				if (!Object.hasOwn(args, "value")) {
					throw new Error("Missing owned store value");
				}
				entry.values[args.key] = structuredClone(args.value);
				return { handled: true, value: null };
			}
			if (command === "plugin:store|save") {
				keys(args, ["rid"]);
				const entry = store(args);
				storage.setItem(
					`chat-page-native-store:${entry.path}`,
					JSON.stringify(entry.values)
				);
				return { handled: true, value: null };
			}
			// The Changes pane reads the working tree through the native shell once
			// its review request is closed. These are its three read-only git reads
			// for the owned workspace, answered as a clean repository.
			if (command === "shell_execute") {
				keys(args, ["command", "cwd", "shell"]);
				if (
					args.cwd !== "/tmp/ryu-chat-controls-project" ||
					args.shell !== null ||
					!workingTreeReads.includes(String(args.command))
				) {
					throw new Error("Unknown owned shell command");
				}
				return { handled: true, value: { code: 0, stderr: "", stdout: "" } };
			}
			return { handled: false, value: undefined };
		},
	};
}
