// The app-updates proof's native boundary: the Tauri IPC bridge (stores, the
// sealed secret slots and the updater commands) and the window globals the
// specs read. It is its own module, imported first by the proof page, so the
// bridge exists before any desktop module loads. The auth client starts reading
// its sealed vault while it is imported; installed later, that first read
// failed and left the vault locked, so no account-scoped row ever rendered.
import { z } from "zod";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import { isDesktopSecretCommand } from "./desktop-secret-slots.ts";

interface PendingUpdateProof {
	scheduled_for_ms: number;
	time_zone: string;
	verdict: Record<string, unknown>;
	version: string;
}

interface TauriInternalsBridge {
	invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
	transformCallback: (...args: unknown[]) => number;
}

// The specs read these arrays and the pending update through the same
// declaration, so they cannot disagree about a type.
declare global {
	interface Window {
		__appUpdateCheckUrls: string[];
		__appUpdateFailures: string[];
		__appUpdateIpcCalls: Array<{
			command: string;
			args?: Record<string, unknown>;
			acknowledged: boolean;
		}>;
		__appUpdateIpcCommands: string[];
		__appUpdateUnknownCommands: string[];
		__pendingAppUpdate: PendingUpdateProof | null;
	}
}

window.__appUpdateCheckUrls = [];
window.__appUpdateIpcCommands = [];
window.__pendingAppUpdate = JSON.parse(
	localStorage.getItem("proof:pending-app-update") ?? "null"
);
window.__appUpdateFailures = [];
window.__appUpdateUnknownCommands = [];
window.__appUpdateIpcCalls = [];
const nativeStores = createChatPageNativeDependencies({
	getItem: (key) => localStorage.getItem(`app-updates-proof:${key}`),
	setItem: (key, value) =>
		localStorage.setItem(`app-updates-proof:${key}`, value),
});
const pendingUpdateProofSchema = z.strictObject({
	scheduled_for_ms: z.number().int().positive(),
	time_zone: z.string().min(1),
	version: z.literal("1.1.0"),
	verdict: z.looseObject({
		current: z.literal("1.0.0"),
		latest: z.literal("1.1.0"),
		channel: z.enum(["stable", "beta", "canary", "nightly"]),
		tag: z.literal("v1.1.0"),
		update_available: z.literal(true),
	}),
});
let automaticDownload =
	localStorage.getItem("proof:automatic-download") === null
		? new URLSearchParams(window.location.search).get("scenario") !==
			"available"
		: localStorage.getItem("proof:automatic-download") === "true";

const tauriInternals: TauriInternalsBridge = {
	invoke: async (command, args) => {
		window.__appUpdateIpcCommands.push(command);
		const call = { command, args, acknowledged: false };
		window.__appUpdateIpcCalls.push(call);
		const refused = window.__appUpdateFailures.indexOf(command);
		if (refused >= 0) {
			window.__appUpdateFailures.splice(refused, 1);
			throw new Error("Fixture native write refused");
		}
		const result = await (async () => {
			if (
				command.startsWith("plugin:store|") ||
				isDesktopSecretCommand(command, args)
			) {
				const result = nativeStores.invoke(command, args);
				if (result.handled) {
					return result.value;
				}
			}
			if (
				command !== "set_app_update_download_preference" &&
				command !== "set_pending_app_update" &&
				args &&
				Object.keys(args).length
			) {
				throw new Error(`Unexpected app update proof arguments: ${command}`);
			}
			if (command === "plugin:app|version") {
				return "1.0.0";
			}
			// A signed-in account's Billing section reads the node registry; this
			// proof has the one local node, with its token already attached.
			if (command === "list_nodes") {
				return {
					default: "local",
					nodes: [
						{
							name: "local",
							token: "app-updates-proof-node-token",
							url: window.location.origin,
							userJwt: null,
						},
					],
				};
			}
			if (command === "get_app_update_download_preference") {
				return automaticDownload;
			}
			if (command === "set_app_update_download_preference") {
				if (
					!args ||
					Object.keys(args).length !== 1 ||
					typeof args.enabled !== "boolean"
				) {
					throw new Error("Invalid automatic-download fixture request");
				}
				automaticDownload = args.enabled;
				localStorage.setItem(
					"proof:automatic-download",
					String(automaticDownload)
				);
				return null;
			}
			if (command === "get_prepared_app_update") {
				if (
					new URLSearchParams(window.location.search).get("scenario") ===
					"prepared"
				) {
					return {
						artifactFile: "Ryu-1.1.0-test",
						artifactSize: 128,
						schemaVersion: 1,
						signature: "fixture-signature",
						source: { channel: "stable", kind: "tag", tag: "v1.1.0" },
						version: "1.1.0",
					};
				}
				return null;
			}
			if (command === "install_prepared_app_update") {
				return true;
			}
			if (command === "get_pending_app_update") {
				return window.__pendingAppUpdate;
			}
			if (command === "set_pending_app_update") {
				if (!args || Object.keys(args).length !== 1) {
					throw new Error("Invalid pending-update fixture request");
				}
				window.__pendingAppUpdate = pendingUpdateProofSchema.parse(
					args.pending
				);
				localStorage.setItem(
					"proof:pending-app-update",
					JSON.stringify(window.__pendingAppUpdate)
				);
				return window.__pendingAppUpdate;
			}
			if (command === "clear_pending_app_update") {
				window.__pendingAppUpdate = null;
				localStorage.removeItem("proof:pending-app-update");
				return null;
			}
			if (command === "plugin:process|restart") {
				return null;
			}
			throw new Error(`Unsupported app update proof command: ${command}`);
		})().catch((error: unknown) => {
			window.__appUpdateUnknownCommands.push(
				`${command}: ${JSON.stringify(args)}`
			);
			throw error;
		});
		call.acknowledged = true;
		return result;
	},
	transformCallback: () => 0,
};
Object.assign(window, { __TAURI_INTERNALS__: tauriInternals });
