// The `RyuPlugin` host API — the contract a Ryu plugin's `activate()` receives.
//
// This is the SINGLE canonical home for the host API surface. The desktop
// extension host (proprietary, closed source) IMPLEMENTS this contract; the
// types ship here in the OSS `@ryuhq/sdk` so plugins stay buildable against a
// stable, open contract (the open-core invariant: the host is closed, the
// contract is open). See `docs/desktop-extension-host-spec.md`.
//
// Design notes:
// - Every `register*()` returns a `Disposable` (the VS Code pattern). A plugin
//   collects them in `context.subscriptions`; `deactivate()` disposes all, so
//   disable/uninstall is leak-free — no dangling routes/commands/panels.
// - This file is TYPES + factory shape ONLY. It imports NOTHING (not even React)
//   and has no runtime side effects, so it is safe in the OSS SDK, when installed
//   standalone (`@ryuhq/sdk` is published), and in any bundler. The desktop host
//   provides the concrete `RyuPlugin` instance.
// - UI contributions are declared DECLARATIVELY here (a route path/title + a
//   sandboxed-webview `entry`). The OSS contract stays framework-agnostic: it does
//   NOT carry a React component type. Trusted, in-process React components are a
//   desktop-HOST concern (the host's own registry owns the `(tab) => ReactNode`
//   render-fn, see `apps/desktop/src/contributions/registry.ts`), not the public
//   contract. WHERE plugin UI renders (trusted host registry vs sandboxed child
//   webview) is the host's decision per the three-tier UI model in the spec.

/** A handle that undoes a registration. Idempotent: calling `dispose()` twice is
 *  a no-op. */
export interface Disposable {
	dispose(): void;
}

/** Build a {@link Disposable} from a teardown function. */
export function toDisposable(teardown: () => void): Disposable {
	let done = false;
	return {
		dispose() {
			if (done) {
				return;
			}
			done = true;
			teardown();
		},
	};
}

// ── Contribution descriptors ──────────────────────────────────────────────────

/** A tab/route a plugin adds. `path` is matched against `tab.path` (exact match
 *  unless `pattern` is set). The host loads `webview.entry` in a sandboxed
 *  surface as the tab body.
 *
 *  Note: the OSS contract is declarative + sandboxed-webview only. A trusted,
 *  in-process React component is a desktop-host capability (the host's registry
 *  accepts a `(tab) => ReactNode` render-fn for BUILT-INS and first-party bundled
 *  plugins); it is intentionally absent from this framework-agnostic contract. */
export interface RouteContribution {
	/** Exact path (e.g. "/my-plugin") or, with `pattern: true`, a RegExp source
	 *  string matched against the full path (e.g. "^/my-plugin/[^/]+$"). */
	path: string;
	/** Treat `path` as a RegExp source string rather than an exact match. */
	pattern?: boolean;
	/** Human title (tab label, command-palette entry). */
	title: string;
	/** Load plugin UI in a SANDBOXED webview with NO Tauri IPC; the plugin reaches
	 *  capabilities only over the host RPC bridge. */
	webview: { entry: string };
}

/** A named mount region a panel can target. Generalizes the desktop's existing
 *  per-section slots (sidebar sections, settings tabs, the chat side-panel, the
 *  companion overlay) into declared contribution points. */
export type PanelRegion =
	| "sidebar-section"
	| "settings-tab"
	| "chat-side-panel"
	| "companion-overlay";

export interface PanelContribution {
	/** Stable id within the region (also the host's key). */
	id: string;
	region: PanelRegion;
	title: string;
	webview: { entry: string };
}

/** A command-palette entry. Shaped to map 1:1 onto the desktop's
 *  `CommandAction` (from `@ryu/command/types`) so a contributed command lands in
 *  the same palette as built-ins with no shim. */
export interface CommandContribution {
	/** Group heading in the palette. Defaults to the plugin's display name. */
	group?: string;
	id: string;
	/** Extra fuzzy-search terms. */
	keywords?: string;
	/** The side effect. Runs in the host; for sandboxed plugins it is an RPC. */
	run(): void | Promise<void>;
	/** Right-aligned keyboard hint (e.g. "⌘⇧P"). */
	shortcut?: string;
	title: string;
}

export interface SettingsSectionContribution {
	id: string;
	title: string;
	webview: { entry: string };
}

/** A section in the unified Store/marketplace surface. */
export interface StoreSectionContribution {
	id: string;
	title: string;
	webview: { entry: string };
}

/** A theme a plugin contributes (CSS custom-property overrides keyed by token). */
export interface ThemeContribution {
	id: string;
	name: string;
	tokens: Record<string, string>;
}

// ── Host services (proxied to Core over the host RPC) ─────────────────────────

/** The host-service surface a plugin calls back into. Each method is mediated by
 *  the host and grant-gated by the manifest (#443). For a sandboxed plugin these
 *  are RPCs over the postMessage bridge; the plugin never holds a Core token or
 *  Tauri IPC handle directly. */
export interface RyuHostServices {
	/** Run a registered command by id (built-in or contributed). */
	commands: { execute(id: string, ...args: unknown[]): Promise<unknown> };
	/** Gateway-governed model access (chat/embed). Mirrors `@ryuhq/sdk` model
	 *  client semantics; every call still routes through the Gateway. */
	gateway: {
		chat(
			model: string,
			messages: { role: string; content: string }[]
		): Promise<string>;
	};
	/** List the agents on the active node, PROJECTED to `{id,name}` only. The host
	 *  holds the Core token and performs the fetch; the plugin never sees a token
	 *  or any other agent field (invariant: no capability returns a secret). Gated
	 *  by the `core:list_agents` grant. */
	listAgents(): Promise<{ id: string; name: string }[]>;
	/** Open a tab at a path (built-in or a route this plugin contributed). */
	openTab(path: string): void;
	/** Read/write the plugin's own Spaces docs (scoped by grant). */
	spaces: {
		ingestDocument(
			spaceId: string,
			title: string,
			markdown: string
		): Promise<{ docId: string }>;
	};
}

// ── The host API a plugin's activate() receives ───────────────────────────────

/** Everything a plugin can contribute. Each `register*` returns a
 *  {@link Disposable}; collect them in {@link PluginContext.subscriptions}. */
export interface RyuPlugin {
	/** Host services the plugin calls back into (grant-gated). */
	readonly host: RyuHostServices;
	registerCommand(contribution: CommandContribution): Disposable;
	registerPanel(contribution: PanelContribution): Disposable;
	registerRoute(contribution: RouteContribution): Disposable;
	registerSettingsSection(
		contribution: SettingsSectionContribution
	): Disposable;
	registerStoreSection(contribution: StoreSectionContribution): Disposable;
	registerTheme(contribution: ThemeContribution): Disposable;
}

/** Passed to `activate(context)`. The plugin pushes its disposables onto
 *  `subscriptions`; the host disposes them all on `deactivate`. */
export interface PluginContext {
	readonly plugin: RyuPlugin;
	/** The plugin's own id (from `plugin.json`). */
	readonly pluginId: string;
	/** Disposables auto-cleaned on deactivate. */
	readonly subscriptions: Disposable[];
}

/** The shape the host expects a plugin's entry module to export. */
export interface RyuPluginModule {
	activate(context: PluginContext): void | Promise<void>;
	deactivate?(): void | Promise<void>;
}

/** Identity helper for authoring a typed plugin module (no runtime behavior). */
export function definePlugin(plugin: RyuPluginModule): RyuPluginModule {
	return plugin;
}
