import {
	ryuCatalogModelsSchema,
	ryuCatalogSnapshotSchema,
	ryuProviderUsageReadingSchema,
	ryuSubscriptionsSchema,
} from "@ryu/app-host/app-bridge";
import { useModelContextStore } from "@ryu/app-host/model-context";
import { assertOpenedFileUri } from "@ryu/app-host/opened-file";
import {
	appBackupMethodSchema,
	appBackupResponseSchema,
	backgroundProcessSchema,
	chatConversationSummarySchema,
	chatSendResultSchema,
	createI18nHostServices,
	cryptoStatusSchema,
	type HostServices,
	spaceDatabaseQueryResultSchema,
	spaceDocumentWriteResultSchema,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { z } from "zod";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import {
	listChatBroadcastConversations,
	sendChatBroadcastTurn,
} from "@/src/lib/api/chat-broadcast.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { resolveNodeShareOrigins } from "@/src/lib/api/node-share.ts";
import {
	pluginHostInvoke,
	pluginHostInvokeStream,
} from "@/src/lib/api/plugins.ts";
import {
	type SpaceMatch as DesktopSpaceMatch,
	searchSpace,
} from "@/src/lib/api/spaces.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import {
	backgroundStopResponseSchema,
	spaceDatabaseResponseSchema,
	spaceDocumentResponseSchema,
	spaceDocumentSummarySchema,
} from "./node-response-contracts.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";

export function buildPluginHostCoreServices({
	assistantContextRef,
	assistantOwner,
	assistantSurfaceRef,
	companion,
	fileAccess,
	getActiveNode,
	i18n,
	isActiveTabRef,
	node,
	onRequestClose,
	toastHost,
}: PluginHostServicesContext): HostServices {
	return {
		...createI18nHostServices(i18n),
		requestClose: onRequestClose ? async () => onRequestClose() : undefined,
		getGlobals: async () => ({
			modelContext: useModelContextStore
				.getState()
				.get("assistant", assistantOwner),
			locale: i18n.locale,
		}),
		getModelContext: () =>
			useModelContextStore.getState().get("assistant", assistantOwner),
		updateModelContext: async (input) => {
			const state = useModelContextStore
				.getState()
				.update("assistant", assistantOwner, input);
			return state;
		},
		readOpenedFile: fileAccess
			? async ({ uri }) => await assertOpenedFileUri(fileAccess, uri).read()
			: undefined,
		writeOpenedFile: fileAccess?.editable
			? async (input) => {
					const access = assertOpenedFileUri(fileAccess, input.uri);
					if (input.text !== undefined && access.write) {
						return await access.write(input.text, input.expectedRevision);
					}
					if (input.blob !== undefined && access.writeBlob) {
						return await access.writeBlob(input.blob, input.expectedRevision);
					}
					throw new Error("This file representation is read-only");
				}
			: undefined,
		openExternal: ({ href }) => openExternal(href),
		uiToastDismiss: (input) => toastHost.dismiss(input),
		uiToastShow: (input) => toastHost.show(input),
		uiToastUpdate: (input) => toastHost.update(input),
		// ── Assistant bridge ───────────────────────────────────────────────────
		// The app tells the ONE global "Ask Ryu" surface what its page is showing,
		// and (optionally) lends it this page's own instructions while the page is
		// open. Everything is scoped by the owning plugin id: an app replaces its
		// OWN context slice and can clear only its OWN takeover, so two apps (or an
		// app and the page under it) never clobber each other. Nothing is readable
		// back — this is a write-only channel into the assistant's prompt.
		assistantPublishContext: async ({ items }) => {
			// `source` is stamped HERE, by the shell, from the companion's real
			// name — never taken from the app's own payload, which could claim
			// to be anything.
			// Ids are namespaced by this app's owner key, so an app cannot collide
			// with (or remove) another publisher's chip, or mimic the shell's own
			// `tab:` chip, by choosing its ids.
			assistantContextRef.current = items.map((i) => ({
				...i,
				id: `${assistantOwner}:${i.id}`,
				source: companion.name,
			}));
			if (isActiveTabRef.current) {
				useAssistantStore
					.getState()
					.publishContext(assistantOwner, assistantContextRef.current);
			}
		},
		assistantClearContext: async () => {
			assistantContextRef.current = [];
			useAssistantStore.getState().clearContextOwner(assistantOwner);
		},
		assistantRegisterSurface: async (surface) => {
			assistantSurfaceRef.current = {
				conversationId: assistantOwner,
				// An app-defined kind, so `buildBuilderPreamble` uses the surface's
				// own `preamble` instead of a built-in builder's instructions.
				kind: `plugin:${companion.pluginId}`,
				label: surface.label,
				description: surface.description,
				preamble: surface.preamble,
				prompts: surface.prompts,
				thread: surface.thread,
				tools: surface.tools,
				// Registering must not pop the panel open — see the store's `dock` doc.
				dock: false,
				snapshot: "",
				targetId: companion.id,
				targetName: surface.label,
				resolveId: () => Promise.resolve(companion.id),
				onChanged: () => undefined,
			};
			if (isActiveTabRef.current) {
				useAssistantStore
					.getState()
					.registerBuilder(assistantSurfaceRef.current);
			}
		},
		assistantClearSurface: async () => {
			assistantSurfaceRef.current = null;
			useAssistantStore.getState().clearBuilder(assistantOwner);
		},
		assistantOpen: async ({ mode, prompt }) => {
			// Only the focused app may open (or ask) the assistant; a background
			// tab's late call would otherwise pop it over another page and spend a
			// turn under that page's context.
			if (!isActiveTabRef.current) {
				throw new Error(
					"assistant.open is only available while the app is focused"
				);
			}
			useAssistantStore.getState().open(mode);
			if (prompt) {
				// Asking on the user's behalf is a real turn on their budget, and it
				// lands in the thread looking exactly like something they typed. So
				// the question is ATTRIBUTED here, by the shell, from the companion's
				// real name — the same rule the context path follows, applied to the
				// higher-power half. `assistant.open()` with no prompt just shows the
				// panel and writes nothing.
				useAssistantStore
					.getState()
					.setPendingPrompt(`[asked by ${companion.name}] ${prompt}`);
			}
		},
		listAgents: async () => {
			const agents = await fetchAgents(toTarget(node));
			return agents.map((a) => ({ id: a.id, name: a.name }));
		},
		nodeShareOrigins: () => resolveNodeShareOrigins(getActiveNode()),
		// Richer projection for a per-agent model picker (still no secrets — just
		// the public engine/model binding + flagship flag).
		listAgentsFull: async () => {
			const agents = await fetchAgents(toTarget(node));
			return agents.map((a) => ({
				id: a.id,
				name: a.name,
				engine: a.engine,
				model: a.model,
				recommended: a.recommended,
			}));
		},
		registerRoute: (claim) => {
			if (!validatePluginRoute(companion.id, claim)) {
				return Promise.reject(
					new Error(`route '${claim.path}' is not this plugin's own surface`)
				);
			}
			// The route is already minted by usePluginContributionRoutes; this is
			// the plugin CLAIMING it, and the host acknowledging the valid claim.
			return Promise.resolve({ path: claim.path });
		},
		// App host-bridge services. Each is ONE governed fetch to the Core endpoint
		// keyed by the OWNING plugin id (companion.pluginId, NOT companion.id). The
		// method is the DOTTED wire name the Core endpoint maps to the bridge
		// (`bridge_path_for`: model.complete→host.sideModel, storage.get→
		// host.storage_get, …); args are forwarded verbatim (already validated in
		// rpc.ts). The host holds the node token; the frame never does.
		catalogSnapshot: () =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"catalog.snapshot",
				{}
			).then(ryuCatalogSnapshotSchema.parse),
		catalogModels: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"catalog.models",
				input
			).then(ryuCatalogModelsSchema.parse),
		// Subscription accounts (subscriptions:read) — Core-bridge verbs; Core
		// also requires a verified node owner/admin caller.
		subscriptionsList: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"subscriptions.list",
				input
			).then(ryuSubscriptionsSchema.parse),
		subscriptionsUsage: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"subscriptions.usage",
				input
			).then(ryuProviderUsageReadingSchema.parse),
		chatListConversations: () =>
			listChatBroadcastConversations(toTarget(node)).then(
				z.array(chatConversationSummarySchema).parse
			),
		chatSend: (input) =>
			sendChatBroadcastTurn(toTarget(node), input).then(
				chatSendResultSchema.parse
			),
		runAgent: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"agent.run",
				input
			).then(z.string().parse),
		backgroundList: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"background.list",
				input
			).then(z.array(backgroundProcessSchema).parse),
		backgroundStop: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"background.stop",
				input
			).then(backgroundStopResponseSchema.parse),
		backupsRequest: (method, input) => {
			const backupMethod = appBackupMethodSchema.parse(method);
			return pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				backupMethod,
				input
			).then(appBackupResponseSchema(backupMethod).parse);
		},
		storageGet: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"storage.get",
				input
			).then(z.string().nullable().parse),
		storageSet: async (input) => {
			await pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"storage.set",
				input
			);
		},
		storageDelete: async (input) => {
			await pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"storage.delete",
				input
			);
		},
		storageKeys: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"storage.keys",
				input
			).then(z.array(z.string()).parse),
		// Sealing: the app hands over plaintext and gets back an opaque envelope.
		// The key is derived per app inside Core and never crosses to the frame,
		// so these are host round-trips rather than a local crypto helper.
		cryptoSeal: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"crypto.seal",
				input
			).then(z.string().parse),
		cryptoOpen: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"crypto.open",
				input
			).then(z.string().parse),
		cryptoStatus: () =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"crypto.status",
				{}
			).then(cryptoStatusSchema.parse),
		// Streaming agent.run: reply text arrives token-by-token via `emit`; the
		// SSE fetch is aborted when `signal` fires (frame cancel).
		runAgentStream: (input, emit, signal) =>
			pluginHostInvokeStream(toTarget(node), companion.pluginId, input, {
				onChunk: emit,
				signal,
			}),
		// Creation runs through the caller-scoped app bridge; semantic retrieval
		// remains a host-direct Core API call. The frame never receives the node
		// token, and Core applies its normal user/organization visibility checks.
		spacesEnsureSpace: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.ensureSpace",
				input
			).then(z.string().parse),
		spacesSearch: async (input) => {
			const matches = await searchSpace(
				toTarget(node),
				input.space_id,
				input.query,
				input.limit
			);
			return matches.map((match: DesktopSpaceMatch) => ({
				chunk_id: match.chunkId,
				content: match.content,
				distance: match.distance,
				document_id: match.documentId,
			}));
		},
		// Spaces documents — the app owns Space docs of kind app:<pluginId>.
		spacesCreateDoc: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.createDoc",
				input
			).then(z.string().parse),
		spacesGetDoc: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.getDoc",
				input
			).then(spaceDocumentResponseSchema.parse),
		spacesUpdateDoc: async (input) => {
			await pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.updateDoc",
				input
			);
		},
		spacesListDocs: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.listDocs",
				input
			).then(z.array(spaceDocumentSummarySchema).parse),
		spacesDeleteDoc: async (input) => {
			await pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.deleteDoc",
				input
			);
		},
		spacesCreateDatabase: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.createDatabase",
				input
			).then(z.string().parse),
		spacesListDatabases: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.listDatabases",
				input
			).then(z.array(spaceDocumentSummarySchema).parse),
		spacesGetDatabase: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.getDatabase",
				input
			).then(spaceDatabaseResponseSchema.parse),
		spacesUpdateDatabase: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.updateDatabase",
				input
			).then(spaceDocumentWriteResultSchema.parse),
		spacesQueryDatabase: (input) =>
			pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.queryDatabase",
				input
			).then(spaceDatabaseQueryResultSchema.parse),
		spacesDeleteDatabase: async (input) => {
			await pluginHostInvoke(
				toTarget(node),
				companion.pluginId,
				"spaces.deleteDatabase",
				input
			);
		},
	};
}
