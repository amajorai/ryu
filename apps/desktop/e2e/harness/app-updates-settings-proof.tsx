import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { AppUpdatesSettings } from "../../src/components/settings/AppUpdatesSettings.tsx";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import { isDesktopSecretCommand } from "./desktop-secret-slots.ts";
import "../../src/index.css";

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

function installUpdateApiMock(): () => void {
	const nativeFetch = window.fetch.bind(window);
	// Browser fetch has no Bun-only `preconnect`; the replacement covers the call.
	window.fetch = (async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const requestUrl = new URL(url, window.location.href);
		if (requestUrl.pathname === "/api/version") {
			return Response.json({
				components: [],
				platform: "test",
				ryu_version: "1.0.0",
			});
		}
		if (requestUrl.pathname === "/api/update/check") {
			window.__appUpdateCheckUrls.push(requestUrl.toString());
			if (
				new URLSearchParams(window.location.search).get("scenario") ===
				"check-error"
			) {
				return Response.json(
					{ error: "Fixture update service failure" },
					{
						status: 500,
					}
				);
			}
			if (
				new URLSearchParams(window.location.search).get("scenario") === "cutoff"
			) {
				return Response.json({
					asset: null,
					channel: "stable",
					current: "1.0.0",
					cutoff_unresolved: false,
					error: null,
					html_url: "https://updates.example.test/releases/v1.1.0",
					latest: "1.0.0",
					latest_unrestricted: "1.1.0",
					notes: "Fixture update notes",
					restricted_by_cutoff: true,
					update_available: false,
				});
			}
			const available = ["available", "prepared"].includes(
				new URLSearchParams(window.location.search).get("scenario") ?? ""
			);
			return Response.json({
				asset: available
					? {
							kind: "installer",
							name: "Ryu-1.1.0-test",
							size: 128,
							url: "https://updates.example.test/Ryu-1.1.0-test",
						}
					: null,
				channel: requestUrl.searchParams.get("channel") ?? "stable",
				current: "1.0.0",
				error: null,
				html_url: "https://updates.example.test/releases/v1.1.0",
				latest: available ? "1.1.0" : "1.0.0",
				notes: "Fixture update notes",
				tag: available ? "v1.1.0" : null,
				update_available: available,
			});
		}
		if (requestUrl.pathname === "/api/auth/get-session") {
			return Response.json({ session: null, user: null });
		}
		if (requestUrl.pathname === "/api/plugins") {
			return Response.json({ apps: [] });
		}
		if (requestUrl.pathname === "/api/plugins/contributions") {
			return Response.json({ settings_tabs: [] });
		}
		if (requestUrl.pathname === "/api/gateway/status") {
			return Response.json({ reachable: false, url: null });
		}
		if (requestUrl.pathname.startsWith("/api/")) {
			return Response.json({}, { status: 404 });
		}
		return nativeFetch(input, init);
	}) as typeof window.fetch;
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const setSettingsOpen = useSettingsDialog((state) => state.setOpen);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);
	useEffect(() => installUpdateApiMock(), []);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<EntitlementProvider>
					<I18nProvider>
						<I18nDirectionProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<Toaster position="bottom-right" theme="dark" />
								<main
									className="min-h-dvh bg-background p-8 text-foreground"
									data-testid="app-updates-settings-proof"
								>
									<div className="mx-auto max-w-5xl rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 font-semibold text-2xl">App updates</h1>
										<p className="mt-2 mb-6 text-muted-foreground text-sm">
											Automatic downloads, manual checks, and the release
											channel.
										</p>
										<AppUpdatesSettings />
									</div>
								</main>
								<SettingsDialog
									defaultSection={settingsSection}
									onOpenChange={setSettingsOpen}
									open={settingsOpen}
								/>
							</ThemeProvider>
						</I18nDirectionProvider>
					</I18nProvider>
				</EntitlementProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	);
}
