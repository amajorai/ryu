// Must evaluate before the auth client: see early-tauri-bridge.ts.
import "./early-tauri-bridge.ts";
import { z } from "zod";

declare const window: GeneralProofWindow;

import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { vaultHydrated } from "../../lib/auth-client.ts";
import { DEFAULT_CORE_URL } from "../../lib/core-url.ts";
import { GeneralTab } from "../../src/components/settings/GeneralTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { initializeProjectlessTaskFolder } from "../../src/hooks/useProjectlessTaskFolder.ts";
import type { GatewayAcpConfig } from "../../src/lib/api/gateway.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
	pluginRecord,
} from "../../src/lib/api/plugin-wire-values.ts";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import { installEarlyTauriHandler } from "./early-tauri-bridge.ts";
import "../../src/index.css";

interface GeneralProofCall {
	args?: Record<string, unknown>;
	command: string;
}

interface GeneralGatewayCall {
	body: PluginDocument | null;
	method: string;
	path: string;
}

interface GeneralProofFixture {
	failNextCommand: (command: string, message?: string) => void;
	failNextFolderDialog: (message?: string) => void;
	failNextGatewayRequest: (path: string, message?: string) => void;
	setFolderSelection: (path: string | null) => void;
}

interface GeneralProofWindow extends Window {
	__GENERAL_NATIVE_STORE_MODE__?: "native" | "browser-fallback";
	__generalGatewayCalls: GeneralGatewayCall[];
	__generalNativeStoreCalls: Array<{
		args?: Record<string, unknown>;
		command: string;
		acknowledged: boolean;
		value?: unknown;
	}>;
	__generalProofCalls: GeneralProofCall[];
	__generalProofFixture: GeneralProofFixture;
	__generalUnknownCommands: string[];
	__TAURI_INTERNALS__?: {
		invoke: (
			command: string,
			args?: Record<string, unknown>
		) => Promise<unknown>;
		transformCallback: (...args: unknown[]) => number;
	};
}

function readFixtureBoolean(key: string, fallback: boolean): boolean {
	const stored = localStorage.getItem(key);
	return stored === null ? fallback : stored === "true";
}

function readFixtureValue<T>(
	key: string,
	fallback: T,
	schema: z.ZodType<T>
): T {
	try {
		const stored = localStorage.getItem(key);
		return stored === null ? fallback : schema.parse(JSON.parse(stored));
	} catch {
		return fallback;
	}
}

// This narrowed Window installs the declared fixture ledgers and controls.
// HTTP envelopes are validated at their seam; stored readback stays independent.
const proofWindow = window;
const generalProofCalls: GeneralProofCall[] = [];
const generalUnknownCommands: string[] = [];
const generalGatewayCalls: GeneralGatewayCall[] = [];
const generalNativeStoreCalls: GeneralProofWindow["__generalNativeStoreCalls"] =
	[];
function exactBooleanArgument(
	command: string,
	args: Record<string, unknown> | undefined,
	key: string
) {
	const value = args?.[key];
	if (
		!args ||
		typeof args !== "object" ||
		Array.isArray(args) ||
		Object.keys(args).length !== 1 ||
		typeof value !== "boolean"
	) {
		generalUnknownCommands.push(command);
		throw new Error(`Invalid Boolean General native request: ${command}`);
	}
	return value;
}
const nativeStores = createChatPageNativeDependencies({
	getItem: (key) =>
		localStorage.getItem(
			key.replace("chat-page-native-store:", "general-proof:native-store:")
		),
	setItem: (key, value) =>
		localStorage.setItem(
			key.replace("chat-page-native-store:", "general-proof:native-store:"),
			value
		),
});
const commandFailures = new Map<string, string>();
const gatewayFailures = new Map<string, string>();
let autostartEnabled = readFixtureBoolean(
	"general-proof:autostart-enabled",
	false
);
let hideTrayIcon = readFixtureBoolean("general-proof:hide-tray-icon", false);
let closeToTray = readFixtureBoolean("general-proof:close-to-tray", true);
let startHidden = readFixtureBoolean("general-proof:start-hidden", false);
let coreStatus: "running" | "stopped" = "running";
let safeModeEnabled = readFixtureBoolean(
	"general-proof:safe-mode-sentinel",
	false
);
let folderSelection: string | null = "/Users/test/Projectless";
let folderDialogFailure: string | null = null;
proofWindow.__generalProofCalls = generalProofCalls;
proofWindow.__generalUnknownCommands = generalUnknownCommands;
proofWindow.__generalGatewayCalls = generalGatewayCalls;
proofWindow.__generalNativeStoreCalls = generalNativeStoreCalls;
proofWindow.__generalProofFixture = {
	failNextCommand: (command, message = "Fixture command failed") => {
		commandFailures.set(command, message);
	},
	failNextGatewayRequest: (path, message = "Fixture API request failed") => {
		gatewayFailures.set(path, message);
	},
	failNextFolderDialog: (message = "Fixture dialog failed") => {
		folderDialogFailure = message;
	},
	setFolderSelection: (path) => {
		folderSelection = path;
	},
};
const SECRET_SLOT_PREFIX = "general-proof:sealed-slot:";
// The desktop's sealed secret slots (`desktop_secret_*`). The native command
// seals with the desktop key; this fixture only models the slot boundary, with
// a record that survives reload. In browser-fallback mode the host has no
// slots: an unknown command resolves `undefined`, which the auth client reads
// as "no native backend" and keeps the vault in memory only.
function handleSecretSlot(
	command: string,
	args: Record<string, unknown> | undefined
): string | null | undefined {
	if (proofWindow.__GENERAL_NATIVE_STORE_MODE__ === "browser-fallback") {
		return undefined;
	}
	const name = args?.name;
	if (name !== "auth-vault" && name !== "license-key") {
		generalUnknownCommands.push(command);
		throw new Error(`Invalid secret slot request: ${command}`);
	}
	const key = `${SECRET_SLOT_PREFIX}${name}`;
	if (command === "desktop_secret_get") {
		return localStorage.getItem(key);
	}
	if (command === "desktop_secret_set" && typeof args?.value === "string") {
		localStorage.setItem(key, args.value);
		return null;
	}
	if (command === "desktop_secret_delete") {
		localStorage.removeItem(key);
		return null;
	}
	generalUnknownCommands.push(command);
	throw new Error(`Invalid secret slot request: ${command}`);
}
proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		generalProofCalls.push({ command, args });
		const commandFailure = commandFailures.get(command);
		if (commandFailure) {
			commandFailures.delete(command);
			throw new Error(commandFailure);
		}
		if (command.startsWith("desktop_secret_")) {
			const call: GeneralProofWindow["__generalNativeStoreCalls"][number] = {
				command,
				args,
				acknowledged: false,
			};
			generalNativeStoreCalls.push(call);
			const value = handleSecretSlot(command, args);
			call.value = value;
			call.acknowledged = true;
			return value;
		}
		if (
			command === "plugin:event|listen" &&
			args?.event === "desktop-secret-changed"
		) {
			return 1;
		}
		if (command.startsWith("plugin:store|")) {
			const call: GeneralProofWindow["__generalNativeStoreCalls"][number] = {
				command,
				args,
				acknowledged: false,
			};
			generalNativeStoreCalls.push(call);
			try {
				if (
					command === "plugin:store|load" &&
					proofWindow.__GENERAL_NATIVE_STORE_MODE__ === "browser-fallback"
				) {
					if (
						!args ||
						typeof args.path !== "string" ||
						!["auth.bin", "entitlement.bin", "companion.bin"].includes(
							args.path
						) ||
						args.options !== undefined ||
						Object.keys(args).some((key) => !["path", "options"].includes(key))
					) {
						throw new Error("Invalid browser-fallback Store load");
					}
					// An explicit supported-load refusal exercises shipping fallback.
					// It does not certify native Store persistence.
					return Promise.reject(
						new Error("Native store unavailable in General browser fixture")
					);
				}
				const result = nativeStores.invoke(command, args);
				if (result.handled) {
					if (
						command === "plugin:store|set" ||
						command === "plugin:store|delete"
					) {
						// Model the installed native Store's default autosave boundary
						// with independent persisted browser records. No OS/fsync claim.
						for (const store of nativeStores.snapshot().stores) {
							localStorage.setItem(
								`general-proof:native-store:${store.path}`,
								JSON.stringify(store.values)
							);
						}
					}
					call.value = structuredClone(result.value);
					call.acknowledged = true;
					return result.value;
				}
			} catch (error) {
				generalUnknownCommands.push(command);
				throw error;
			}
		}
		if (command === "set_default_node") {
			if (args?.name !== "local" || Object.keys(args).length !== 1) {
				generalUnknownCommands.push(command);
				throw new Error("Invalid default-node fixture request");
			}
			localStorage.setItem("general-proof:native-default-node", args.name);
			return null;
		}
		if (command === "get_default_projectless_task_folder") {
			return String.raw`C:\Users\Proof\Documents\Ryu\Projects`;
		}
		if (command === "plugin:autostart|is_enabled") {
			return autostartEnabled;
		}
		if (command === "plugin:autostart|enable") {
			autostartEnabled = true;
			localStorage.setItem("general-proof:autostart-enabled", "true");
			return null;
		}
		if (command === "plugin:autostart|disable") {
			autostartEnabled = false;
			localStorage.setItem("general-proof:autostart-enabled", "false");
			return null;
		}
		if (command === "plugin:dialog|open") {
			if (folderDialogFailure) {
				const failure = folderDialogFailure;
				folderDialogFailure = null;
				throw new Error(failure);
			}
			return folderSelection;
		}
		if (command === "get_hide_tray_icon") {
			return hideTrayIcon;
		}
		if (command === "get_close_to_tray") {
			return closeToTray;
		}
		if (command === "get_start_hidden") {
			return startHidden;
		}
		if (command === "set_hide_tray_icon") {
			hideTrayIcon = exactBooleanArgument(command, args, "hidden");
			localStorage.setItem(
				"general-proof:hide-tray-icon",
				String(hideTrayIcon)
			);
			return null;
		}
		if (command === "set_close_to_tray") {
			closeToTray = exactBooleanArgument(command, args, "enabled");
			localStorage.setItem("general-proof:close-to-tray", String(closeToTray));
			return null;
		}
		if (command === "set_start_hidden") {
			startHidden = exactBooleanArgument(command, args, "hidden");
			localStorage.setItem("general-proof:start-hidden", String(startHidden));
			return null;
		}
		if (command === "get_safe_mode_sentinel") {
			return safeModeEnabled;
		}
		if (command === "set_safe_mode_sentinel") {
			safeModeEnabled = exactBooleanArgument(command, args, "enabled");
			localStorage.setItem(
				"general-proof:safe-mode-sentinel",
				String(safeModeEnabled)
			);
			return null;
		}
		if (command === "stop_ryu_core") {
			coreStatus = "stopped";
			return null;
		}
		if (command === "get_ryu_status") {
			return coreStatus;
		}
		if (command === "start_ryu_core") {
			coreStatus = "running";
			return "mock-core-started";
		}
		generalUnknownCommands.push(command);
		throw new Error(`Unsupported General native command: ${command}`);
	},
	transformCallback: () => 0,
};
installEarlyTauriHandler(proofWindow.__TAURI_INTERNALS__.invoke);

const INITIAL_ACP: GatewayAcpConfig = {
	active_agents: 1,
	auto_max_parallel_agents: 2,
	effective_max_parallel_agents: 2,
	hardware: {
		cpu_cores: 8,
		physical_cores: 4,
		total_ram_bytes: 16 * 1024 ** 3,
	},
	idle_timeout_minutes: 10,
	keep_computer_awake: true,
	max_parallel_agents: null,
};

const AcpSchema = z.object({
	active_agents: z.number(),
	auto_max_parallel_agents: z.number(),
	effective_max_parallel_agents: z.number(),
	hardware: z.object({
		cpu_cores: z.number(),
		physical_cores: z.number(),
		total_ram_bytes: z.number(),
	}),
	idle_timeout_minutes: z.number(),
	keep_computer_awake: z.boolean(),
	max_parallel_agents: z.number().nullable(),
});
const GatewaySchema = z.object({ acp: AcpSchema });
const SafeModeSchema = z.object({
	enabled: z.boolean(),
	preference_enabled: z.boolean(),
	source: z.string(),
	suppressed: z.object({
		kernel_plugins: z.number(),
		mcp_servers: z.number(),
		plugins: z.number(),
		skills: z.number(),
	}),
	user_clearable: z.boolean(),
});

const GATEWAY_CONFIG_KEY = "general-proof:gateway-config";
const SAFE_MODE_KEY = "general-proof:safe-mode-state";
const DEFAULT_SAFE_MODE = {
	enabled: false,
	preference_enabled: false,
	source: "off",
	suppressed: { kernel_plugins: 4, mcp_servers: 2, plugins: 3, skills: 12 },
	user_clearable: true,
};
let gatewayConfig = readFixtureValue(
	GATEWAY_CONFIG_KEY,
	{ acp: INITIAL_ACP },
	GatewaySchema
);

function installGatewayMock(): () => void {
	gatewayConfig = readFixtureValue(
		GATEWAY_CONFIG_KEY,
		{ acp: INITIAL_ACP },
		GatewaySchema
	);
	autostartEnabled = readFixtureBoolean(
		"general-proof:autostart-enabled",
		false
	);
	hideTrayIcon = readFixtureBoolean("general-proof:hide-tray-icon", false);
	closeToTray = readFixtureBoolean("general-proof:close-to-tray", true);
	startHidden = readFixtureBoolean("general-proof:start-hidden", false);
	coreStatus = "running";
	safeModeEnabled = readFixtureBoolean(
		"general-proof:safe-mode-sentinel",
		false
	);
	generalProofCalls.length = 0;
	generalGatewayCalls.length = 0;
	commandFailures.clear();
	gatewayFailures.clear();
	folderSelection = "/Users/test/Projectless";
	folderDialogFailure = null;
	let scenarioSaveErrorConsumed = false;
	let safeMode = readFixtureValue(
		SAFE_MODE_KEY,
		DEFAULT_SAFE_MODE,
		SafeModeSchema
	);
	const nativeFetch = window.fetch.bind(window);
	window.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const rawUrl = input instanceof Request ? input.url : String(input);
			const requestUrl = new URL(rawUrl, window.location.href);
			const path = requestUrl.pathname;
			if (path !== "/api/safe-mode" && path !== "/api/gateway/config") {
				return nativeFetch(input, init);
			}
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			const refuse = (reason: string, status = 422) => {
				generalUnknownCommands.push(
					`HTTP ${method} ${requestUrl.href}: ${reason}`
				);
				return new Response(JSON.stringify({ error: reason }), {
					headers: { "content-type": "application/json" },
					status,
				});
			};
			if (requestUrl.href !== `${DEFAULT_CORE_URL}${path}`) {
				return refuse("Undeclared General fixture authority or query", 403);
			}
			let request: Request;
			try {
				request = new Request(input, init);
			} catch {
				return refuse("Invalid General native Request", 400);
			}
			// This finite fixture owns only the shipping tokenless local fallback.
			// It does not certify Core authorization or account-session admission.
			if (
				request.headers.get("content-type") !== "application/json" ||
				request.headers.get("authorization") !== null ||
				request.headers.get("x-ryu-user-jwt") !== null ||
				request.headers.get("x-ryu-buyer-token") !== null ||
				!request.headers.get("x-ryu-client-id") ||
				request.headers.get("x-ryu-client-id") !==
					localStorage.getItem("ryu_client_id")
			) {
				return refuse("Undeclared General fixture headers", 401);
			}
			if (method !== "GET" && method !== "PUT") {
				return refuse("Undeclared General fixture method", 405);
			}
			const raw = await request.text();
			let body: PluginDocument | null = null;
			if (raw !== "") {
				try {
					body = pluginDocumentSchema.parse(JSON.parse(raw));
				} catch {
					return refuse("Malformed General JSON document", 400);
				}
			}
			generalGatewayCalls.push({ body, method, path });
			if (method === "GET" && raw !== "") {
				return refuse("Undeclared General read body");
			}
			if (method === "PUT") {
				if (!body) {
					return refuse("Missing General write document");
				}
				if (path === "/api/safe-mode") {
					if (
						Object.keys(body).length !== 1 ||
						typeof body.enabled !== "boolean"
					) {
						return refuse("Undeclared Safe Mode write shape");
					}
				} else {
					const acp = pluginRecord(body.acp);
					if (
						Object.keys(body).length !== 1 ||
						!acp ||
						Object.keys(acp).length !== 3 ||
						typeof acp.keep_computer_awake !== "boolean" ||
						typeof acp.idle_timeout_minutes !== "number" ||
						!Number.isInteger(acp.idle_timeout_minutes) ||
						acp.idle_timeout_minutes < 0 ||
						!(
							acp.max_parallel_agents === null ||
							(typeof acp.max_parallel_agents === "number" &&
								Number.isInteger(acp.max_parallel_agents) &&
								acp.max_parallel_agents > 0)
						)
					) {
						return refuse("Undeclared General ACP write shape");
					}
				}
			}
			const failure = gatewayFailures.get(path);
			if (failure) {
				gatewayFailures.delete(path);
				return new Response(JSON.stringify({ error: failure }), {
					headers: { "content-type": "application/json" },
					status: 503,
				});
			}
			if (path === "/api/safe-mode") {
				if (method === "PUT") {
					const enabled = body!.enabled === true;
					safeMode = {
						...safeMode,
						enabled,
						preference_enabled: enabled,
						source: enabled ? "preference" : "off",
					};
					localStorage.setItem(SAFE_MODE_KEY, JSON.stringify(safeMode));
				}
				return new Response(JSON.stringify(safeMode), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}
			if (method === "PUT") {
				if (
					new URLSearchParams(window.location.search).get("scenario") ===
						"save-error" &&
					!scenarioSaveErrorConsumed
				) {
					scenarioSaveErrorConsumed = true;
					return new Response(
						JSON.stringify({ error: "Fixture save failure" }),
						{
							headers: { "content-type": "application/json" },
							status: 500,
						}
					);
				}
				const acp = pluginRecord(body!.acp)!;
				const currentAcp = gatewayConfig.acp ?? INITIAL_ACP;
				gatewayConfig = {
					...gatewayConfig,
					acp: {
						...currentAcp,
						idle_timeout_minutes: Number(acp.idle_timeout_minutes),
						keep_computer_awake: acp.keep_computer_awake === true,
						max_parallel_agents:
							acp.max_parallel_agents === null
								? null
								: Number(acp.max_parallel_agents),
					},
				};
				localStorage.setItem(GATEWAY_CONFIG_KEY, JSON.stringify(gatewayConfig));
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}
			return new Response(JSON.stringify(gatewayConfig), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		},
		nativeFetch
	);
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	const location = useLocation();
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);

	useEffect(() => installGatewayMock(), []);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<I18nProvider>
					<I18nDirectionProvider>
						<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
							<Toaster position="bottom-right" theme="dark" />
							<main
								className="min-h-dvh bg-background p-8 text-foreground"
								data-testid="desktop-general-settings-proof"
							>
								<div className="mx-auto flex max-w-5xl flex-col gap-6">
									<header className="rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 font-semibold text-2xl">
											General preferences
										</h1>
										<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
											The live Desktop settings surface, including persisted
											workspace defaults and the active node's keep-awake
											policy.
										</p>
									</header>
									<section className="rounded-2xl border bg-card p-6 shadow-sm">
										<GeneralTab />
									</section>
									<output data-testid="proof-current-path" hidden>
										{location.pathname}
									</output>
								</div>
							</main>
						</ThemeProvider>
					</I18nDirectionProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	// The shipping App waits for this actual auth vault promise before mounting
	// its regular Layout. Preserve that boot order for native mirror recovery.
	void Promise.all([initializeProjectlessTaskFolder(), vaultHydrated]).then(
		() => {
			createRoot(root).render(
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			);
		}
	);
}
