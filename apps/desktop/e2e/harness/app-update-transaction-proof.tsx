import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Store } from "@tauri-apps/plugin-store";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppUpdatesSettings } from "../../src/components/settings/AppUpdatesSettings.tsx";
import { UpdateStartupScreen } from "../../src/components/startup/UpdateStartupScreen.tsx";
import { useUpdateStartupHealth } from "../../src/hooks/useUpdateStartupHealth.ts";
import {
	updateProofRecordSchema,
	updateProofStoreValueSchemas,
	updateProofStringSchema,
} from "../app-update-transaction-proof.contracts.ts";
import "../../src/index.css";

declare global {
	interface Window {
		updateProofCalls: string[];
		updateProofCommitted: boolean;
		updateProofDownloadPreference: {
			/** Refuse the next `count` native writes (default 1); combines with holdNext. */
			failNext: (count?: number) => void;
			holdNext: () => void;
			release: () => void;
			persisted: () => boolean;
			pending: () => number;
			accepted: boolean[];
		};
		updateProofIpcRequests: { command: string; args: InvokeArgs | undefined }[];
		updateProofRuntimeReady: boolean;
		updateProofShowUnrelatedToast: () => void;
		updateProofUnknownCommands: string[];
	}
}

// Only the native IPC boundary is replaced. The real settings component,
// preparation coordinator, install action, and error handling run unchanged.
window.updateProofCalls = [];
window.updateProofUnknownCommands = [];
window.updateProofIpcRequests = [];
window.updateProofRuntimeReady = false;
window.updateProofCommitted = false;
window.updateProofShowUnrelatedToast = () => {
	toast.error({
		id: "update-proof-unrelated-error",
		title: "Other pending action",
		description: "This separate action still needs attention.",
		duration: null,
	});
};
const DOWNLOAD_PREFERENCE_KEY = "ryu-proof:automatic-app-download";
let refusedPreferenceWrites = 0;
let holdNextPreference = false;
let releasePreference: (() => void) | null = null;
let pendingPreferenceWrites = 0;
const acceptedPreferences: boolean[] = [];
function persistedDownloadPreference(): boolean {
	const stored = sessionStorage.getItem(DOWNLOAD_PREFERENCE_KEY);
	if (stored === null) {
		return true;
	}
	if (stored !== "true" && stored !== "false") {
		throw new Error("Malformed owned preference storage");
	}
	return stored === "true";
}
window.updateProofDownloadPreference = {
	failNext(count = 1) {
		if (refusedPreferenceWrites > 0 || !Number.isInteger(count) || count < 1) {
			throw new Error("Already armed preference write");
		}
		refusedPreferenceWrites = count;
	},
	holdNext() {
		if (holdNextPreference || releasePreference) {
			throw new Error("Already armed preference write");
		}
		holdNextPreference = true;
	},
	release() {
		if (!releasePreference) {
			throw new Error("No actual held preference command");
		}
		releasePreference();
		releasePreference = null;
	},
	persisted: persistedDownloadPreference,
	pending: () => pendingPreferenceWrites,
	accepted: acceptedPreferences,
};
const query = new URLSearchParams(window.location.search);
let pendingUpdate = query.has("pending")
	? {
			scheduled_for_ms: Date.now() + 24 * 60 * 60 * 1000,
			time_zone: "UTC",
			version: "9.9.9",
			verdict: {
				current: "0.4.0",
				latest: "9.9.9",
				channel: "stable",
				tag: "v9.9.9",
				update_available: true,
				asset: null,
				notes: null,
				html_url: null,
			},
		}
	: null;
// The installed plugin-store SDK loads a numeric resource and returns [value,
// exists] from get. These are the only stores imported by this settings tree.
const proofStores = new Map([
	[
		"auth.bin",
		{
			rid: 4103,
			keys: new Set(["accounts", "activeUserId", "token"]),
			values: new Map<string, Parameters<Store["set"]>[1]>(),
		},
	],
	[
		"entitlement.bin",
		{
			rid: 4101,
			keys: new Set(["firstLaunchAtMs", "lastGoodEntitlement", "licenseKey"]),
			values: new Map<string, Parameters<Store["set"]>[1]>(),
		},
	],
	[
		"companion.bin",
		{
			rid: 4102,
			keys: new Set([
				"companion_consent",
				"companion_app_allowlist",
				"companion_paused",
				"companion_frames",
				"shadow_history_retention_days",
			]),
			values: new Map<string, Parameters<Store["set"]>[1]>(),
		},
	],
]);
const loadedStoreRids = new Set<number>();
mockIPC((command, payload) => {
	const record = updateProofRecordSchema.safeParse(payload);
	const args = record.success ? record.data : {};
	window.updateProofCalls.push(command);
	window.updateProofIpcRequests.push({ command, args: payload });
	if (command === "plugin:store|load" && record.success) {
		const path = updateProofStringSchema.safeParse(args.path);
		const store = path.success ? proofStores.get(path.data) : undefined;
		if (
			store &&
			args.options === undefined &&
			Object.keys(args).every((key) => key === "path" || key === "options")
		) {
			loadedStoreRids.add(store.rid);
			return store.rid;
		}
	} else if (
		record.success &&
		(command === "plugin:store|get" ||
			command === "plugin:store|set" ||
			command === "plugin:store|delete" ||
			command === "plugin:store|save")
	) {
		const store = [...proofStores.values()].find(
			(entry) => entry.rid === args.rid
		);
		if (store && loadedStoreRids.has(store.rid)) {
			if (
				command === "plugin:store|save" &&
				Object.keys(args).every((key) => key === "rid")
			) {
				return undefined;
			}
			const key = updateProofStringSchema.safeParse(args.key);
			if (key.success && store.keys.has(key.data)) {
				const allowedKeys =
					command === "plugin:store|set"
						? ["rid", "key", "value"]
						: ["rid", "key"];
				if (Object.keys(args).every((key) => allowedKeys.includes(key))) {
					if (command === "plugin:store|get") {
						return [
							store.values.get(key.data) ?? null,
							store.values.has(key.data),
						];
					}
					if (command === "plugin:store|delete" && store.rid === 4103) {
						return store.values.delete(key.data);
					}
					const value =
						command === "plugin:store|set" && Object.hasOwn(args, "value")
							? updateProofStoreValueSchemas
									.get(key.data)
									?.safeParse(args.value)
							: undefined;
					if (
						command === "plugin:store|set" &&
						Object.hasOwn(args, "value") &&
						value?.success
					) {
						store.values.set(key.data, structuredClone(args.value));
						return undefined;
					}
				}
			}
		}
	}
	if (command === "get_pending_app_update") {
		return pendingUpdate;
	}
	if (command === "clear_pending_app_update") {
		if (new URLSearchParams(window.location.search).has("cancelFailure")) {
			throw new Error("Could not clear the saved update schedule");
		}
		pendingUpdate = null;
		return null;
	}
	if (command === "get_update_startup_health") {
		if (query.has("startupFailure")) {
			throw new Error("recovery guard did not commit");
		}
		return query.has("startup") && !window.updateProofCommitted
			? window.updateProofRuntimeReady
			: null;
	}
	if (command === "acknowledge_update_startup") {
		return window.updateProofRuntimeReady;
	}
	if (command === "plugin:app|version") {
		return "0.4.0";
	}
	if (command === "get_app_update_download_preference") {
		return persistedDownloadPreference();
	}
	if (
		command === "set_app_update_download_preference" &&
		record.success &&
		payload !== undefined &&
		Object.keys(payload).length === 1 &&
		typeof args.enabled === "boolean"
	) {
		const enabled = args.enabled;
		const refused = refusedPreferenceWrites > 0;
		const held = holdNextPreference;
		if (refused) {
			refusedPreferenceWrites--;
		}
		holdNextPreference = false;
		pendingPreferenceWrites++;
		return (async () => {
			try {
				if (held) {
					await new Promise<void>((resolve) => {
						releasePreference = resolve;
					});
				}
				if (refused) {
					throw new Error("Owned native automatic-download preference refused");
				}
				sessionStorage.setItem(DOWNLOAD_PREFERENCE_KEY, String(enabled));
				acceptedPreferences.push(enabled);
				return null;
			} finally {
				pendingPreferenceWrites--;
			}
		})();
	}
	if (command === "get_prepared_app_update") {
		return {
			artifactFile: "ryu-update-9.9.9.bin",
			artifactSize: 4096,
			schemaVersion: 1,
			signature: "IPC fixture; not an installable signed artifact",
			source: { kind: "stable" },
			version: "9.9.9",
		};
	}
	if (command === "install_prepared_app_update") {
		if (new URLSearchParams(window.location.search).has("failure")) {
			const attempt = window.updateProofCalls.filter(
				(call) => call === "install_prepared_app_update"
			).length;
			throw new Error(
				`Runtime preparation failed on attempt ${attempt}. The previous runtime remains available.`
			);
		}
		return null; // Native user selected Keep working.
	}
	const unknown = `${command}: ${JSON.stringify(payload)}`;
	window.updateProofUnknownCommands.push(unknown);
	throw new Error(`Unexpected update proof IPC command: ${unknown}`);
});

const root = document.getElementById("root");
const queryClient = new QueryClient();
function StartupObserver() {
	const status = useUpdateStartupHealth(true, true);
	return status === "ready" ? (
		<AppUpdatesSettings />
	) : (
		<div className="h-[70vh]">
			<UpdateStartupScreen status={status} />
		</div>
	);
}
function ProofApp() {
	const [startupMounted, setStartupMounted] = useState(
		query.has("startup") || query.has("ordinary")
	);
	return (
		<QueryClientProvider client={queryClient}>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<section className="mx-auto max-w-2xl space-y-6">
					<h1 className="font-semibold text-2xl">App updates</h1>
					{startupMounted ? <StartupObserver /> : <AppUpdatesSettings />}
					{startupMounted && query.has("unmount") && (
						<button onClick={() => setStartupMounted(false)} type="button">
							Close startup screen
						</button>
					)}
				</section>
			</main>
			<Toaster position="bottom-right" theme="system" />
		</QueryClientProvider>
	);
}
if (root) {
	createRoot(root).render(<ProofApp />);
}
