// Mounts a THIRD-PARTY plugin's bundled UI through `@ryu/app-host`'s sandboxed,
// null-origin iframe on the island surface, gated by the plugin's GATEWAY-APPROVED
// grants. Island port of the desktop `PluginHostPanel`.
//
// The one structural difference from desktop is transport: island's renderer
// cannot reach Core directly (CORS excludes Electron origins), so the trusted host
// services delegate to the `window.island.plugins.*` IPC methods (the main process
// holds the node token; the plugin frame never does). It:
//   - fetches the plugin's bundled code over IPC (keyed by the OWNING plugin id),
//   - builds the granted capability set from the plugin's Gateway-approved grants
//     (deny-safe: an empty approved list yields an empty capability set),
//   - implements the privileged host services (listAgents projected to `{id,name}`;
//     registerRoute scoped to this plugin's own surface; the 6 host-bridge services
//     + runAgentStream via the island transport, keyed by `companion.pluginId`;
//     media.recording through the shared in-document recorder and media.transcribe
//     through Core with the user's Voice Recognition engine), and
//   - wraps the frame in a visible "App" attribution header so it is never mistaken
//     for system chrome.
//
// Renders nothing runnable unless the companion carries a UI bundle (`hasUi`).

import {
	ryuCatalogModelsSchema,
	ryuCatalogSnapshotSchema,
	ryuProviderUsageReadingSchema,
	ryuSubscriptionsSchema,
} from "@ryu/app-host/app-bridge";
import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	backgroundProcessSchema,
	type Capability,
	capabilitiesFromGrants,
	createI18nHostServices,
	cryptoStatusSchema,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "@ryu/app-host/third-party-plugin";
import { browserRecordingHost } from "@ryu/blocks/companion/browser-recording";
import { useI18n, useLiteralMessages } from "@ryu/i18n/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { PluginCompanion } from "../../shared/ipc.ts";
import {
	pluginHostInvoke as invokeHost,
	pluginHostInvokeStream as invokeHostStream,
} from "./island-plugin-host-invoke.ts";
import {
	createIslandTranscribeAudio,
	islandTranscribeBridge,
} from "./island-transcribe.ts";

const agentListSchema = z.object({
	agents: z.array(
		z
			.object({ id: z.string(), name: z.string().optional().catch(undefined) })
			.nullable()
			.catch(null)
	),
});

/** Base64-encode a UTF-8 string (btoa is Latin-1 only). Inlines the plugin bundle
 *  into the sandboxed `srcdoc` so a body containing `</script>` cannot break the
 *  tag (defense in depth; the sandbox is the real boundary). */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

type BundleState =
	| { status: "loading" }
	| { status: "ready"; code: string | null; coreGeneration: number }
	| { status: "error" };

export function IslandPluginHost({
	companion,
}: {
	companion: PluginCompanion;
}) {
	const i18n = useI18n();
	const tl = useLiteralMessages();
	// One microphone owner per host document, keyed by the owning plugin id (as on
	// desktop). Unmounting stops this app's live capture; its pending clip stays
	// with the shared recorder so a remount can still read or discard it.
	useEffect(
		() => () => browserRecordingHost.release(companion.pluginId),
		[companion.pluginId]
	);
	const [connected, setConnected] = useState(false);
	const [bundle, setBundle] = useState<BundleState>({ status: "loading" });
	// Start locked, then refresh the node preference for this app mount. The island
	// keeps its contribution list in memory, so a settings change from another
	// surface must be re-read before this frame can open network access.
	const [defaultCspEnforced, setDefaultCspEnforced] = useState(true);
	// Keep a first-paint snapshot and a live copy of the shared Desktop appearance
	// contract. The island is a separate Electron process, so its own root is the
	// host for the null-origin Companion frame.
	const [initialThemeTokens] = useState(readCompanionThemeTokens);
	const [themeTokens, setThemeTokens] = useState(initialThemeTokens);
	useEffect(() => {
		if (!("MutationObserver" in globalThis)) {
			return;
		}
		const observer = new MutationObserver(() => {
			setThemeTokens(readCompanionThemeTokens());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		window.island.plugins
			.contributions()
			.then((result) => {
				if (!result.available || cancelled) {
					return;
				}
				const current = result.companions.find(
					(candidate) => candidate.id === companion.id
				);
				if (current) {
					setDefaultCspEnforced(current.defaultCspEnforced);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [companion.id]);

	// Fetch the plugin's bundled code over IPC (the main process holds the token).
	// Keyed by the OWNING plugin id (the store key), not the companion id.
	useEffect(() => {
		let cancelled = false;
		const requestId = `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		setBundle({ status: "loading" });
		window.island.plugins
			.uiBundle(companion.pluginId, requestId)
			.then((result) => {
				if (cancelled) {
					return;
				}
				setBundle(
					result.available &&
						result.coreGeneration !== undefined &&
						result.coreGeneration === companion.coreGeneration
						? {
								status: "ready",
								code: result.code,
								coreGeneration: result.coreGeneration,
							}
						: { status: "error" }
				);
			})
			.catch(() => {
				if (!cancelled) {
					setBundle({ status: "error" });
				}
			});
		return () => {
			cancelled = true;
			void window.island.plugins
				.abortUiBundle(requestId)
				.catch(() => undefined);
		};
	}, [companion.pluginId, companion.coreGeneration]);

	// Trusted host closure: sandbox RPC inputs cannot supply or replace this epoch.
	const coreGeneration =
		bundle.status === "ready" ? bundle.coreGeneration : undefined;
	const pluginHostInvoke = useCallback(
		(
			pluginId: string,
			method: string,
			args: Parameters<typeof invokeHost>[2]
		) => invokeHost(pluginId, method, args, coreGeneration),
		[coreGeneration]
	);
	const pluginHostInvokeStream = useCallback(
		(
			pluginId: string,
			input: Parameters<typeof invokeHostStream>[1],
			options: { onChunk: (delta: string) => void; signal?: AbortSignal }
		) => invokeHostStream(pluginId, input, { ...options, coreGeneration }),
		[coreGeneration]
	);

	// One nonce per mount. Host-generated, never plugin/user input.
	const nonce = useMemo(
		() =>
			"randomUUID" in crypto
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[defaultCspEnforced, coreGeneration]
	);

	// The granted set comes from the plugin's GATEWAY-APPROVED grants. DENY-SAFE: an
	// empty approved list yields an empty set (the plugin can call nothing).
	const grantsKey = useMemo(
		() => [...new Set(companion.approvedGrants)].sort().join(" "),
		[companion.approvedGrants]
	);
	// grantsKey is the content hash of approvedGrants.
	const granted = useMemo<ReadonlySet<Capability>>(
		() => capabilitiesFromGrants(companion.approvedGrants),
		[grantsKey]
	);
	const handleConnected = useCallback(() => setConnected(true), []);

	// The privileged services. `listAgents` returns a minimal `{id,name}` projection
	// over IPC; `registerRoute` accepts ONLY this plugin's own `/plugin/<id>` path
	// (anti-phishing); the host-bridge services delegate to the island transport,
	// keyed by the OWNING plugin id (`companion.pluginId`, NOT `companion.id`).
	const services = useMemo<HostServices>(
		() => ({
			...createI18nHostServices(i18n),
			timelineTranscripts: (input) =>
				window.island.shadow.getSpeechHistory(input),
			// Generic companion media services (grants `media:transcribe` /
			// `media:record`). Capture runs in this trusted main frame, the only
			// frame Electron's permission handler lets open the microphone.
			transcribeAudio: createIslandTranscribeAudio(islandTranscribeBridge),
			mediaRecording: (input) =>
				browserRecordingHost.call(companion.pluginId, input),
			storageCompareAndSet: (input) =>
				pluginHostInvoke(
					companion.pluginId,
					"storage.compareAndSet",
					input
				).then((raw) => z.boolean().parse(raw)),
			listAgents: async () => {
				const result = await window.island.plugins.coreHttp({
					coreGeneration,
					method: "GET",
					path: "/api/agents",
				});
				if (!result.ok) {
					return [];
				}
				const parsed = agentListSchema.safeParse(result.data);
				if (!parsed.success) {
					return [];
				}
				return parsed.data.agents.flatMap((agent) =>
					agent === null ? [] : [{ id: agent.id, name: agent.name ?? agent.id }]
				);
			},
			catalogSnapshot: () =>
				pluginHostInvoke(companion.pluginId, "catalog.snapshot", {}).then(
					(raw) => ryuCatalogSnapshotSchema.parse(raw)
				),
			catalogModels: (input) =>
				pluginHostInvoke(companion.pluginId, "catalog.models", input).then(
					(raw) => ryuCatalogModelsSchema.parse(raw)
				),
			// Subscription accounts (subscriptions:read) — Core-bridge verbs; Core
			// also requires a verified node owner/admin caller.
			subscriptionsList: (input) =>
				pluginHostInvoke(companion.pluginId, "subscriptions.list", input).then(
					(raw) => ryuSubscriptionsSchema.parse(raw)
				),
			subscriptionsUsage: (input) =>
				pluginHostInvoke(companion.pluginId, "subscriptions.usage", input).then(
					(raw) => ryuProviderUsageReadingSchema.parse(raw)
				),
			registerRoute: (claim) => {
				if (!validatePluginRoute(companion.id, claim)) {
					return Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					);
				}
				return Promise.resolve({ path: claim.path });
			},
			modelComplete: (input) =>
				pluginHostInvoke(companion.pluginId, "model.complete", input).then(
					(raw) => z.string().parse(raw)
				),
			runAgent: (input) =>
				pluginHostInvoke(companion.pluginId, "agent.run", input).then((raw) =>
					z.string().parse(raw)
				),
			backgroundList: (input) =>
				pluginHostInvoke(companion.pluginId, "background.list", input).then(
					(raw) => z.array(backgroundProcessSchema).parse(raw)
				),
			backgroundStop: (input) =>
				pluginHostInvoke(companion.pluginId, "background.stop", input).then(
					(raw) =>
						z
							.object({
								ok: z.boolean(),
								requested: z.boolean(),
								process_id: z.string(),
							})
							.parse(raw)
				),
			storageGet: (input) =>
				pluginHostInvoke(companion.pluginId, "storage.get", input).then((raw) =>
					z.string().nullable().parse(raw)
				),
			storageSet: async (input) => {
				await pluginHostInvoke(companion.pluginId, "storage.set", input);
			},
			storageDelete: async (input) => {
				await pluginHostInvoke(companion.pluginId, "storage.delete", input);
			},
			storageKeys: (input) =>
				pluginHostInvoke(companion.pluginId, "storage.keys", input).then(
					(raw) => z.array(z.string()).parse(raw)
				),
			// Sealing under the app's own Core-derived key (grant `crypto:seal`).
			// The key never reaches the frame, so these are host round-trips.
			cryptoSeal: (input) =>
				pluginHostInvoke(companion.pluginId, "crypto.seal", input).then((raw) =>
					z.string().parse(raw)
				),
			cryptoOpen: (input) =>
				pluginHostInvoke(companion.pluginId, "crypto.open", input).then((raw) =>
					z.string().parse(raw)
				),
			cryptoStatus: () =>
				pluginHostInvoke(companion.pluginId, "crypto.status", {}).then((raw) =>
					cryptoStatusSchema.parse(raw)
				),
			runAgentStream: (input, emit, signal) =>
				pluginHostInvokeStream(companion.pluginId, input, {
					onChunk: emit,
					signal,
				}),
			shellThemeSubscribe: (_input, emit, signal) =>
				new Promise<void>((resolve) => {
					const push = () => {
						emit(JSON.stringify(readCompanionThemeTokens()));
					};
					push();
					const observer = new MutationObserver(push);
					observer.observe(document.documentElement, {
						attributes: true,
						attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
					});
					const done = () => {
						observer.disconnect();
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
		}),
		[
			companion.id,
			companion.pluginId,
			i18n,
			pluginHostInvoke,
			pluginHostInvokeStream,
			coreGeneration,
		]
	);

	const srcdoc = useMemo(
		() =>
			bundle.status === "ready" &&
			bundle.coreGeneration === companion.coreGeneration &&
			bundle.code
				? /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(bundle.code)
					? htmlCompanionSrcdoc(
							nonce,
							bundle.code,
							companion.id,
							undefined,
							undefined,
							readCompanionThemeTokens(),
							true,
							{ enforceDefaultCsp: defaultCspEnforced }
						)
					: thirdPartyPluginSrcdoc(
							nonce,
							toBase64Utf8(bundle.code),
							companion.id,
							undefined,
							readCompanionThemeTokens(),
							true,
							{ enforceDefaultCsp: defaultCspEnforced }
						)
				: null,
		[bundle, nonce, companion.id, companion.coreGeneration, defaultCspEnforced]
	);

	if (
		bundle.status === "loading" ||
		(bundle.status === "ready" &&
			bundle.coreGeneration !== companion.coreGeneration)
	) {
		return (
			<div
				aria-busy="true"
				aria-label="Loading app"
				className="flex h-full flex-col gap-2 p-3"
			>
				<Skeleton className="h-8 w-2/3 rounded-lg" />
				<Skeleton className="h-8 w-full rounded-lg" />
				<Skeleton className="h-8 w-5/6 rounded-lg" />
			</div>
		);
	}

	if (!srcdoc) {
		return (
			<Empty className="h-full py-12">
				<EmptyHeader>
					<EmptyTitle>Nothing to show here</EmptyTitle>
					<EmptyDescription>
						This app does not provide a runnable UI.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		// The tab strip names the app; the frame is sandboxed app content, so it
		// carries no extra attribution bar or inner border. `aria-busy` marks the
		// frame until its bridge connects.
		<div
			aria-busy={!connected}
			className="flex h-full flex-col overflow-hidden"
			data-app-connected={connected ? "true" : "false"}
		>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					granted={granted}
					key={`${companion.pluginId}:${coreGeneration}`}
					nonce={nonce}
					onConnected={handleConnected}
					services={services}
					srcdoc={srcdoc}
					themeTokens={themeTokens}
					title={tl("App: {name}", { name: companion.name })}
				/>
			</div>
		</div>
	);
}
