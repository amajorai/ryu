// Part of the Island IPC type contract; `./ipc.ts` re-exports it, so import
// from there. Type-only: the sandboxed preload loads `./ipc.ts` at runtime.

import type { RawViewContribution } from "@ryu/app-host/views";

// ── Core: plugin (Ryu App / Companion) host ──────────────────────────────────
//
// The full-page Companion host mirrors the desktop's `PluginHostPanel`, but every
// Core HTTP call runs in the main process (CORS excludes Electron origins) and is
// reached over IPC. The renderer mounts `@ryu/app-host`'s sandboxed iframe and
// implements the privileged host services by delegating to these IPC methods.

/** A companion-surface descriptor contributed by an enabled plugin
 *  (`RunnableKind::Companion`), projected to the renderer. Mirrors the desktop
 *  `PluginCompanion`. `approvedGrants` is the GATEWAY-VALIDATED grant subset for
 *  the owning plugin (the only correct source for the host capability set);
 *  `hasUi` is true when the plugin carries a bundled UI. `pluginId` is the owning
 *  plugin's manifest id (the UI bundle + host invokes are keyed by it, NOT by the
 *  companion `id`). */
export interface PluginCompanion {
	approvedGrants: string[];
	coreGeneration?: number;
	defaultCspEnforced: boolean;
	hasUi: boolean;
	icon: string | null;
	id: string;
	label: string;
	name: string;
	pluginId: string;
	shortcut: string | null;
}

/** A declarative-view contribution as served by Core (`contributes.views[]`), tagged
 *  with its owning `plugin`. Shape-identical to the shared `@ryu/app-host/views`
 *  {@link ViewContribution} — the island renders it host-side with
 *  `@ryu/blocks/island`'s `IslandViewPanel` (the Raycast tier, island idiom), exactly
 *  as the desktop renders the SAME spec full-size. Mirrors the desktop `PluginView`. */
export type PluginView = RawViewContribution & { coreGeneration?: number };

/** Result of the enabled-plugin contributions probe
 *  (`GET /api/plugins/contributions`). Never rejects to the renderer. Carries both the
 *  companion surfaces (sandboxed-UI apps) and the declarative `views` (host-rendered). */
export type PluginContributionsResult =
	| { available: true; companions: PluginCompanion[]; views: PluginView[] }
	| { available: false; reason: string };

/** Result of a plugin UI-bundle fetch (`GET /api/plugins/:id/ui-bundle`). `code`
 *  is null when the plugin has no bundle / is not enabled (Core answers 404). */
export type PluginUiBundleResult =
	| { available: true; code: string | null; coreGeneration?: number }
	| { available: false; reason: string };

/** The closed error code the app host-bridge surfaces to a companion frame.
 *  Mirrors the desktop `PluginHostErrorCode`. */
export type PluginHostErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

/** Body for a one-shot host-bridge invoke (renderer → main). `method` is the
 *  DOTTED wire name Core maps to the bridge (`model.complete`/`agent.run`/
 *  `storage.*`); `args` is forwarded verbatim (already validated in `rpc.ts`). */
export interface PluginHostInvokeRequest {
	args: unknown;
	coreGeneration?: number;
	method: string;
	pluginId: string;
}

/** Discriminated result of a host-bridge invoke. `ok:false` carries the structured
 *  `{ code, message }` so the renderer transport can reconstruct a `PluginHostError`
 *  — `ipcMain.handle` cannot serialize a thrown error's `.code`, so we return it. */
export type PluginHostInvokeResult =
	| { ok: true; result: unknown }
	| { ok: false; code: PluginHostErrorCode; message: string };

/** Body for an authenticated Core HTTP call on behalf of a declarative view
 *  (renderer → main): the http tier of view actions + the view `source` fetch.
 *  `path` must be a Core-relative `/api/...` path (validated main-side too);
 *  `body` (when present) is JSON-serialized. The renderer templates paths/bodies
 *  BEFORE this hop (`@ryu/app-host/views` `renderActionHttp`). */
export interface PluginCoreHttpRequest {
	body?: unknown;
	coreGeneration?: number;
	method: string;
	path: string;
}

/** Discriminated result of a Core HTTP call for a declarative view. `data` is
 *  the parsed JSON body (or `null` when the response carries none). */
export type PluginCoreHttpResult =
	| { ok: true; status: number; data: unknown }
	| { ok: false; code: PluginHostErrorCode; message: string };

/** Body to start a streaming host-bridge `agent.run` (renderer → main). */
export interface PluginHostStreamStartRequest {
	coreGeneration?: number;
	input: unknown;
	pluginId: string;
}

/** Handle returned when a host stream starts; keys the chunk/end events + abort. */
export interface PluginHostStreamHandle {
	streamId: string;
}

/** A streamed reply-token chunk pushed from the main process during a host stream. */
export interface PluginHostStreamChunkEvent {
	delta: string;
	streamId: string;
}

/** Terminal event of a host stream. `error`/`code` are set only when `reason` is
 *  `"error"`. */
export interface PluginHostStreamEndEvent {
	code?: PluginHostErrorCode;
	error?: string;
	reason: "aborted" | "done" | "error";
	streamId: string;
}

/** Plugin-host methods exposed to the renderer (`window.island.plugins`). */
export interface IslandPluginsApi {
	/** Abort an in-flight host stream by id. */
	abortHostStream(streamId: string): Promise<void>;
	abortUiBundle(requestId: string): Promise<void>;
	/** Enabled-plugin companion contributions. Never rejects. */
	contributions(): Promise<PluginContributionsResult>;
	/** Authenticated Core HTTP for a declarative view (http actions + `source`
	 *  fetch). Never rejects; failures come back as `ok:false`. */
	coreHttp(req: PluginCoreHttpRequest): Promise<PluginCoreHttpResult>;
	/** One-shot host-bridge invoke. Never rejects; failures come back as `ok:false`. */
	hostInvoke(req: PluginHostInvokeRequest): Promise<PluginHostInvokeResult>;
	/** Subscribe to host-stream reply chunks. Returns an unsubscribe function. */
	onHostStreamChunk(
		listener: (event: PluginHostStreamChunkEvent) => void
	): () => void;
	/** Subscribe to host-stream terminal events. Returns an unsubscribe function. */
	onHostStreamEnd(
		listener: (event: PluginHostStreamEndEvent) => void
	): () => void;
	onShortcut(listener: (id: string) => void): () => void;
	onSourceChanged(listener: () => void): () => void;
	/** Start a streaming host-bridge `agent.run`. Chunks arrive on the
	 *  `plugins:hostStreamChunk` event and a terminal `plugins:hostStreamEnd`
	 *  event fires when the stream closes. */
	startHostStream(
		req: PluginHostStreamStartRequest
	): Promise<PluginHostStreamHandle>;
	/** Fetch an enabled plugin's bundled UI code. Never rejects. */
	uiBundle(pluginId: string, requestId?: string): Promise<PluginUiBundleResult>;
}

// ── Core: marketplace catalog (skills + MCP) ─────────────────────────────────
//
// A thin browse/install surface over Core's catalog endpoints. All HTTP runs in
// the main process (CORS); every method resolves to a result envelope and never
// rejects to the renderer. MCP installed-state is NOT carried by the catalog
// payload (Core hardcodes false), so it is derived in the main process by
// cross-referencing `GET /api/mcp/servers` (a card is installed iff its id is a
// registered server name).

/** Catalog kinds the marketplace can browse. */
export type CatalogKind = "model" | "skill" | "mcp" | "plugin";

/** One selectable catalog source. Mirrors Core's source descriptor. */
export interface CatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

/** The active source id plus every source for a kind. */
export type CatalogSourcesResult =
	| { available: true; active: string; sources: CatalogSource[] }
	| { available: false; reason: string };

/** A normalized marketplace row (skill or MCP server) for the renderer list. */
export interface CatalogItem {
	description: string | null;
	id: string;
	installed: boolean;
	name: string;
	/** A short secondary line (installs, transports, version, …). */
	subtitle: string | null;
}

/** Result of a catalog list query. */
export type CatalogListResult =
	| { available: true; items: CatalogItem[] }
	| { available: false; reason: string };

/** Result of a catalog install or source-select action. */
export type CatalogActionResult =
	| { available: true; ok: boolean; error?: string }
	| { available: false; reason: string };

/** Body for a catalog list query (renderer → main). */
export interface CatalogListRequest {
	kind: "skill" | "mcp";
	query: string;
}

/** Body for a catalog install (renderer → main). */
export interface CatalogInstallRequest {
	id: string;
	kind: "skill" | "mcp";
}

/** Body for selecting the active source of a kind (renderer → main). */
export interface CatalogSelectSourceRequest {
	id: string;
	kind: "skill" | "mcp";
}

/** Marketplace catalog methods exposed to the renderer (`window.island.catalog`). */
export interface IslandCatalogApi {
	/** Install a skill or MCP server. Never rejects. */
	install(req: CatalogInstallRequest): Promise<CatalogActionResult>;
	/** List the active source's catalog for a kind. Never rejects. */
	list(req: CatalogListRequest): Promise<CatalogListResult>;
	/** Select the active source for a kind. Never rejects. */
	selectSource(req: CatalogSelectSourceRequest): Promise<CatalogActionResult>;
	/** List the catalog sources for a kind. Never rejects. */
	sources(kind: "skill" | "mcp"): Promise<CatalogSourcesResult>;
}
