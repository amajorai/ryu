/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: crates/ryu-kernel-contracts (Rust) via the checked-in
 * schemas/plugin-manifest.schema.json. Regenerate with:
 *
 *   bun run generate:contracts
 *
 * (after re-blessing the schema with
 *  `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts` when the Rust
 *  manifest types change).
 */

/**
 * A host surface a plugin can declare support for via `targets`.
 *
 * `core` is the headless node (a Core running with no UI at all).
 *
 * An **empty/absent** `targets` list means the plugin runs on *every* surface —
 * that is the backward-compatible default and MUST NOT be read as "hidden".
 */
export type Surface = "gateway" | "core" | "desktop" | "island" | "mobile" | "extension" | "web" | "cli";

/**
 * An installable Ryu App manifest (`manifest.json`).
 *
 * Modelled on Codex's `manifest.json` pattern: a thin descriptor that bundles one or
 * more [`RunnableEntry`] items (agents, workflows, tools, skills, companions,
 * channels, engines, policies), lists the permission grants the app requires, and
 * optionally declares a Companion surface (an in-desktop overlay or sidebar panel).
 *
 * # Per-kind config
 *
 * Each Runnable entry carries an optional `config` blob whose schema is
 * determined by its `kind`. See [`crate::schema`] for the per-kind structs and the
 * [`crate::schema::validate_runnable`] function.
 */
export interface PluginManifest {
	/**
	 * Primary brand accent color, hex (Ryu extension: `accentColor`).
	 */
	accentColor?: string | null;
	/**
	 * Activation events that lazily wake the plugin — VS-Code `activationEvents`.
	 * Recognised tokens: `"*"` (always active / eager), `"onStartup"`, `"onChat"`,
	 * `"onCommand:<id>"`, `"onRoute"` (fired the first time a lazy sidecar is woken
	 * by an inbound proxy hit), and `"onCapabilityCall"` (the broker analogue —
	 * fired when a lazy provider sidecar is woken by a capability-broker hit). An
	 * **empty** list means *eager* activation (back-compat: every existing manifest
	 * keeps activating on enable). The activation runtime firing these events lives
	 * in Core's `RunnableRegistry::register_active` + `fire_activation_event`;
	 * `onStartup`/`onChat`/`onRoute`/`onCapabilityCall` fire from Core, while
	 * `onCommand:<id>` fires from the desktop command palette.
	 */
	activation_events?: string[];
	/**
	 * Publisher/author. Claude `author` — a bare string or an object with a
	 * `name` field; the detail builder extracts the display string into
	 * `developer`. Kept as a raw value so both shapes round-trip.
	 */
	author?: {
		[k: string]: unknown;
	};
	/**
	 * The plugin's **backend bundle** — the JavaScript source of the extension-host
	 * entry module a [`crate::schema::SidecarProcess::Node`] sidecar runs (RFC Option
	 * B). This is the backend analogue of `ui_code`: a payload blob that Core writes
	 * to the plugin dir at the node sidecar's declared `entry` path at spawn, then
	 * loads via the embedded host bootstrap. Unlike `ui_code` (which the install path
	 * splits into a DB column so the on-disk manifest stays small), the backend blob
	 * rides **inline** in the manifest so the spawn path is self-contained (it reads
	 * the reconstituted manifest, no separate carriage channel) AND, for a
	 * marketplace plugin, the code is INSIDE the Gateway-signed surface — the whole
	 * backend is signed, not merely hash-bound. Absent for a plugin with no node
	 * backend. Written by `ryu pack`/`ryu publish`.
	 */
	backend_code?: string | null;
	/**
	 * Lower-case hex `sha256(utf8_bytes(backend_code))` — the integrity gate for the
	 * node backend, mirroring [`ui_code_sha256`]. When present, Core recomputes the
	 * hash over the on-disk entry file at spawn and **refuses to start** the node
	 * sidecar on mismatch (fail-closed), so an entry file swapped on disk between
	 * install and spawn can never run. Absent = trust the bundle as written (the same
	 * posture `ui_code_sha256` uses when omitted).
	 *
	 * [`ui_code_sha256`]: PluginManifest::ui_code_sha256
	 */
	backend_sha256?: string | null;
	/**
	 * Detail-page hero banner spec ({colors,style,seed}); opaque passthrough (Ryu ext).
	 */
	banner?: {
		[k: string]: unknown;
	};
	/**
	 * Human-readable capability strings (Ryu extension). When absent the detail
	 * builder DERIVES these from `permission_grants` via
	 * [`crate::schema::capabilities_from_grants`]; declared values are used verbatim.
	 */
	capabilities?: string[];
	/**
	 * Free-text category (Claude `category`).
	 */
	category?: string | null;
	/**
	 * Optional Companion surface descriptor: an in-desktop overlay or sidebar panel
	 * the app may register. Absent when the app has no Companion surface.
	 */
	companion?: CompanionSurface | null;
	/**
	 * VS-Code-style **contribution points**: a declare-by-id block naming which
	 * of the manifest's `runnables` the plugin contributes to each extensible
	 * surface. Every id referenced here MUST exist in `runnables` (the loader
	 * cross-validates). Absent when the plugin contributes nothing extra
	 * (the common case — a plugin's `runnables` are already its contributions).
	 */
	contributes?: Contributes | null;
	/**
	 * Long plaintext/markdown description. Empty when absent (the built-in card
	 * historically emitted `""` for this; preserved).
	 */
	description?: string | null;
	/**
	 * Required Ryu engine version (VS-Code `engines.vscode` analogue). When
	 * present, `engines.ryu` is a semver **requirement** (e.g. `">=0.3.0"`) and
	 * the loader rejects the manifest if the running Core version does not
	 * satisfy it. Absent = compatible with any Core version.
	 */
	engines?: EnginesReq | null;
	/**
	 * Prompt-chip examples (contract key `examplePrompts`; Ryu extension).
	 */
	examplePrompts?: string[];
	/**
	 * Homepage/website URL (Claude `homepage`; emitted as `website`).
	 */
	homepage?: string | null;
	/**
	 * Icon-primitive id for the listing card (Ryu extension: `icon`). An
	 * Iconify/icons0 `prefix:name`, a bare Hugeicons name, or a URL — resolved by
	 * the shared `Icon` primitive. Distinct from `icon_url`: this is a GLYPH id the
	 * card masks with `currentColor`, `icon_url` is a raster logo. When absent the
	 * card falls back to `icon_url`, then a default glyph.
	 */
	icon?: string | null;
	/**
	 * CSS background for the icon square (Ryu extension: `iconBackground`).
	 */
	iconBackground?: string | null;
	/**
	 * Dithered-gradient background for the card's icon square (Ryu extension:
	 * `iconDither`). Opaque passthrough `{ from, to?, direction? }` mirroring
	 * dither-kit's `DitherGradient` props (`from`/`to` are a palette-colour name or
	 * a hue number, `direction` is up|down|left|right). Kept as raw JSON like
	 * `banner` so an untrusted/typo'd value never fails the manifest parse — the
	 * render layer validates and falls back before painting.
	 */
	iconDither?: {
		[k: string]: unknown;
	};
	/**
	 * Logo URL (contract key `iconUrl`; Ryu extension).
	 */
	iconUrl?: string | null;
	/**
	 * Reverse-domain unique identifier for the app (e.g. `"com.example.my-app"`).
	 */
	id: string;
	/**
	 * Search keywords / tags (Claude `keywords`).
	 */
	keywords?: string[];
	/**
	 * SPDX license identifier (Claude `license`).
	 */
	license?: string | null;
	/**
	 * Declarative **stdio MCP servers** this plugin registers into Core's MCP
	 * registry on enable and deregisters on disable/uninstall. Each entry is a
	 * [`McpServerDecl`] keyed by the server name the registry uses (the same key a
	 * user's `mcp.json` would use). This is the manifest-owned successor to Core's
	 * hardcoded built-in MCP servers: a plugin declares its server here instead of
	 * Core baking a `com.ryu.<app>` server into `builtin_servers()`. Empty for the
	 * common case (a plugin that ships no MCP server). A user `mcp.json` entry with
	 * the same name still wins (user-overrides-builtin precedence is preserved by
	 * the registry).
	 */
	mcp_servers?: {
		[k: string]: McpServerDecl;
	};
	/**
	 * Human-readable display name shown in the app store / launcher.
	 */
	name: string;
	/**
	 * Permission grants this app declares it needs (e.g. `"mcp:web_search"`).
	 * These are *declarations only* at this layer — no enforcement happens here;
	 * the Gateway owns grant enforcement.
	 */
	permission_grants?: string[];
	/**
	 * **Unified, deny-by-default runtime permission set** — the single typed
	 * grammar (`{fs, child_process, network, tool}`) Core lowers to every sandbox
	 * backend (wasmtime WASI preopens, Docker `--mount`/`--network` flags, Deno
	 * `--allow-*` flags). Absent = **deny-all** (the default for every manifest
	 * predating this field), so an app that declares nothing keeps today's exact
	 * zero-permission sandbox posture.
	 *
	 * # Relationship to [`permission_grants`]
	 *
	 * These are **two distinct lanes** that must not be conflated:
	 * - [`permission_grants`] are opaque strings the **Gateway** approves at
	 *   install/enable time — the *approval* lane (who is allowed to ask).
	 * - `permissions` is the typed set **Core** lowers into the actual sandbox at
	 *   spawn/exec time — the *runtime-enforcement* lane (what the code can touch).
	 *
	 * A grant says "this app may use the filesystem capability"; `permissions.fs`
	 * says "…and here are the exact read/write paths the sandbox is opened with."
	 *
	 * # Altitude (manifest-level, per-runnable override is a followup)
	 *
	 * Declared at the manifest root because **both** current enforcement sites
	 * resolve their config from the owning manifest, not from a sub-entry: an
	 * `inline_deno` tool's backend is resolved from the manifest by
	 * `McpRegistry::resolve_app_tool_backend`, and a managed sidecar is spawned
	 * from the manifest by `ManifestSidecar`. A per-[`crate::schema::ToolConfig`] /
	 * per-[`crate::schema::SidecarSpec`] override is a clean future extension (the
	 * resolver would fall back to this manifest-level set) but is intentionally not
	 * in v1.
	 */
	permissions?: PermissionSet | null;
	/**
	 * Privacy policy URL (contract key `privacyPolicyUrl`; Ryu extension).
	 */
	privacyPolicyUrl?: string | null;
	/**
	 * **Capabilities this plugin provides** — the inverse of
	 * [`Requires::capabilities`]. Each entry names a capability the plugin's
	 * sidecar can serve for other plugins through the capability broker, binding
	 * the capability to one of this manifest's declared `sidecars` + a proxied
	 * route. Absent/empty for the common case (a plugin that consumes but does not
	 * provide capabilities). The loader cross-validates that every referenced
	 * `sidecar`/`route` exists (like `contributes`).
	 */
	provides?: ProvidesEntry[];
	/**
	 * **Plugin-to-plugin dependencies** — the other plugins this one needs (the
	 * npm-shaped edge that lets the app decompose into a kernel + features).
	 * Resolved into a topological enable order by Core's `plugins::graph`.
	 *
	 * Absent = **no dependencies** (every manifest predating this field).
	 */
	requires?: Requires | null;
	/**
	 * The Runnables this app bundles. Each entry uses [`RunnableEntry`] from the
	 * [`crate::schema`] module so heterogeneous Runnables (agents, workflows,
	 * tools, skills, companions, channels, engines, policies) can be listed
	 * together with their per-kind config.
	 */
	runnables: RunnableEntry[];
	/**
	 * Optional declarative **external runtime** the plugin needs (e.g. a Python
	 * venv + pip deps + assets, like the TTS sidecar). The provisioner lives in
	 * Core (`crate::sidecar::external_runtime`); this is the declaration (#449).
	 * Absent for the common case (no external interpreter needed).
	 */
	runtime?: ExternalRuntimeConfig | null;
	/**
	 * App-Store gallery screenshot URLs (Ryu extension).
	 */
	screenshots?: string[];
	/**
	 * Optional companion/config setup card, or an array of such steps (Ryu
	 * extension). Opaque to Core — passed through to the detail payload verbatim.
	 */
	setup?: {
		[k: string]: unknown;
	};
	/**
	 * Declarative **managed sidecars** the plugin ships (the app ⇄ sidecar
	 * bridge): each is a long-running child process Core downloads/provisions,
	 * spawns, and health-monitors via the Core `SidecarManager` on enable,
	 * exactly like a built-in sidecar. Gated at enable by the `sidecar:process`
	 * grant (Core-tier auto; Community needs the approved grant). Empty for the
	 * common case (no bundled process).
	 */
	sidecars?: SidecarSpec[];
	/**
	 * Provenance hint for the marketplace index: `"builtin"`, an `owner/repo`
	 * slug, or a git/raw URL an external plugin ships from. Absent ⇒ `"builtin"`.
	 * This is an index HINT only — Core derives the real trust tier from
	 * `plugins::builtins` membership at runtime, NOT from this field. Consumed by
	 * the marketplace generator (`tools/mirror-plugins.sh`) to populate each
	 * entry's `source`/`builtin` pair.
	 */
	source?: string | null;
	/**
	 * Per-surface support + UI declaration — the richer successor to [`targets`].
	 *
	 * When **present**, this map is authoritative and [`targets`] is ignored: a
	 * surface is supported iff it has an entry whose [`SurfaceSupport`] is not
	 * [`SurfaceSupport::None`], and an **absent key means the surface is not
	 * supported** (see [`PluginManifest::supports_surface`]). When **absent**, the
	 * predicate falls back to the legacy [`targets`] semantics (empty/absent =
	 * every surface) — so every manifest that predates this field keeps its exact
	 * behaviour. Never make an absent `surfaces` mean "no surfaces".
	 *
	 * [`targets`]: PluginManifest::targets
	 */
	surfaces?: {
		[k: string]: SurfaceEntry;
	} | null;
	/**
	 * Short one-line tagline shown under the name (Ryu extension).
	 */
	tagline?: string | null;
	/**
	 * Host surfaces this plugin runs on (desktop / island / mobile / …).
	 *
	 * **Empty or absent = runs on EVERY surface.** This is the backward-compatible
	 * default and must never be read as "runs nowhere" — every manifest that
	 * predates this field declares no targets and must keep surfacing everywhere.
	 * Filtering happens ONLY when this list is explicitly non-empty, and only at
	 * the read/surface boundary (see [`PluginManifest::supports_surface`]) — never
	 * in the storage layer, so an unsupported-target plugin stays installable and
	 * inspectable.
	 */
	targets?: Surface[];
	/**
	 * Terms-of-service URL (contract key `termsOfServiceUrl`; Ryu extension).
	 */
	termsOfServiceUrl?: string | null;
	/**
	 * Lower-case hex `sha256(utf8_bytes(ui_code))` binding the plugin's bundled
	 * sandboxed-UI code to this manifest. Because the Gateway signs the manifest
	 * verbatim (canonical key-sorted encoding), this hash is INSIDE the signed
	 * surface while the `ui_code` blob itself rides OUTSIDE it as payload; the
	 * install path recomputes the hash over the fetched code and rejects a
	 * mismatch fail-closed. Absent for a manifest-only plugin (no bundled UI) and
	 * for unsigned seed items. Written by `ryu pack`/`ryu publish`.
	 */
	ui_code_sha256?: string | null;
	/**
	 * Semver version string (e.g. `"1.0.0"`).
	 */
	version: string;
}
/**
 * Companion surface descriptor — an optional in-desktop overlay or sidebar panel
 * an App may register. Fields mirror the UX primitives a Companion widget needs;
 * all are optional except `label`.
 */
export interface CompanionSurface {
	/**
	 * Icon identifier (resolved by the desktop shell).
	 */
	icon?: string | null;
	/**
	 * Display label for the companion panel tab or tooltip.
	 */
	label: string;
	/**
	 * Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
	 */
	shortcut?: string | null;
}
/**
 * VS-Code-style **contribution points** (`contributes` in `package.json`).
 *
 * Each field is a list of [`ContributionId`] references into the manifest's
 * `runnables`: the plugin *declares* that runnable `X` contributes to the
 * `commands`/`tools`/`agents`/… surface. This is declare-by-id, not a second
 * copy of the runnable — the loader cross-validates that every referenced id
 * exists in `runnables`, so a typo is caught at load.
 *
 * # Extending
 *
 * Add a new surface = add a new `#[serde(default)] pub <surface>: Vec<ContributionId>`
 * field here. The cross-validation in [`Contributes::referenced_ids`] picks it
 * up automatically.
 */
export interface Contributes {
	/**
	 * Agents the plugin contributes (referenced by runnable id).
	 */
	agents?: ContributionId[];
	/**
	 * Command-palette commands the plugin contributes (referenced by runnable id).
	 */
	commands?: ContributionId[];
	/**
	 * Declarative **native** UI widgets the plugin contributes to the desktop
	 * composer (e.g. a `toggle` that sets a `plugin_flags` entry, or a `chip`).
	 * Core stores these verbatim and serves them via `GET /api/plugins/contributions`;
	 * the desktop renders the known widget types. Opaque to Core (the renderer
	 * owns interpretation) so new widget types need no Core change.
	 */
	composer_controls?: unknown[];
	/**
	 * Gateway policies the plugin contributes (referenced by runnable id).
	 */
	policies?: ContributionId[];
	/**
	 * Declarative settings tabs the plugin contributes (model pickers, text
	 * fields bound to preference keys). Served + rendered the same way.
	 */
	settings_tabs?: unknown[];
	/**
	 * App-registered sidebar **buttons** — a single nav row (e.g. Memory →
	 * `/library/memory`). The button-shaped sibling of [`Contributes::sidebar_sections`]
	 * (no live list, just a label/icon + a client route). See [`SidebarButtonContribution`].
	 */
	sidebar_buttons?: SidebarButtonContribution[];
	/**
	 * App-registered sidebar **sections** — a header plus a live list of rows the
	 * shell fetches from a declared Core `/api/` path. Lets an app own its sidebar
	 * section (Canvas/Whiteboard/Meetings recent-doc lists) instead of the shell
	 * hardcoding it. Self-contained + opaque `spec` (see [`SidebarSectionContribution`]),
	 * so a new section capability needs no Core change; served + tagged with the
	 * owning `plugin` id at `GET /api/plugins/contributions`.
	 */
	sidebar_sections?: SidebarSectionContribution[];
	/**
	 * Slash commands the plugin contributes (e.g. `/goal`). The desktop maps the
	 * command to a `plugin_flags`/message action; the plugin's turn hook reads
	 * the resulting message. Served + rendered the same way.
	 */
	slash_commands?: unknown[];
	/**
	 * Callable tools the plugin contributes (referenced by runnable id).
	 */
	tools?: ContributionId[];
	/**
	 * Chat turn hooks the plugin contributes — server-side logic that runs at a
	 * turn boundary (e.g. `post_assistant_turn`) and returns a directive. These
	 * are **self-contained** (they carry their own inline `code`), so they are
	 * NOT cross-validated against `runnables` like the id-reference surfaces
	 * above; the Core `plugin_host` runtime executes them in the sandbox.
	 */
	turn_hooks?: TurnHookContribution[];
	/**
	 * **Declarative views** the plugin contributes (the Raycast tier). Each entry
	 * is a [`ViewContribution`]: a typed envelope (`id`/`view`) around an **opaque**
	 * `spec` payload the host renderer interprets. The app returns DATA
	 * (`items`/`columns`/`actions`/`fields`) — never code — and the shell renders it
	 * with the host's own `@ryu/ui` components (desktop) or the compact command-bar
	 * idiom (island), so one spec renders natively on every surface and cannot be
	 * made ugly. Like [`composer_controls`]/[`settings_tabs`] this is **self-contained**
	 * (not cross-validated against `runnables`), and the `view` discriminant + `spec`
	 * stay opaque to Core so a new view kind needs no Core change — the renderer owns
	 * the vocabulary (`list-detail`, `data-table`, `form`, `action-panel`,
	 * `filter-bar`, `empty-state`, `stat-card-row`).
	 *
	 * [`composer_controls`]: Contributes::composer_controls
	 * [`settings_tabs`]: Contributes::settings_tabs
	 */
	views?: ViewContribution[];
	/**
	 * App widgets the plugin contributes (Ryu Apps). Each binds a tool id to a
	 * `ui://widget/<slug>.html` template the tool renders inline in chat. The
	 * field is shape-identical to the SDK `manifest.ts` `WidgetContribution`.
	 */
	widgets?: WidgetContribution[];
	/**
	 * Workflows the plugin contributes (referenced by runnable id).
	 */
	workflows?: ContributionId[];
}
/**
 * A single contribution: a reference (by `id`) to a runnable declared in the
 * manifest's `runnables` list, optionally with a human-facing title (e.g. the
 * label a command shows in the palette).
 */
export interface ContributionId {
	/**
	 * The runnable id this contribution points at. Must exist in `runnables`.
	 */
	id: string;
	/**
	 * Optional display title (e.g. the palette label for a command).
	 */
	title?: string | null;
}
/**
 * One app-registered **sidebar button** — a single nav row (the button-shaped
 * sibling of [`SidebarSectionContribution`]). No live list: just a label/icon and a
 * client route the shell opens with `openTab`. Migrates hardcoded header-chrome
 * buttons (e.g. Memory) to the owning app.
 */
export interface SidebarButtonContribution {
	/**
	 * Optional glyph id resolved by the shell's Icon primitive.
	 */
	icon?: string | null;
	/**
	 * Stable id for this button within the plugin.
	 */
	id: string;
	/**
	 * Optional placement hint among the sidebar buttons.
	 */
	order?: number | null;
	/**
	 * The client route this button opens (e.g. `"/library/memory"`).
	 */
	target: string;
	/**
	 * Button label.
	 */
	title: string;
}
/**
 * One app-registered **sidebar section** — a header plus a live list of rows the
 * desktop's compact sidebar renderer draws (the app-owned replacement for the
 * hardcoded Canvas/Whiteboard/Meetings sections). A typed envelope around an opaque
 * `spec` (the `SidebarSectionSpec` in `@ryu/app-host/views`: a `ViewSource` for the
 * rows, an `itemTarget` route template for `openTab`, optional `itemActions` and a
 * `create` action). Core stores it verbatim and tags it with the owning `plugin` id;
 * the `spec` stays opaque so a new section capability is a renderer change, not a
 * Core change.
 */
export interface SidebarSectionContribution {
	/**
	 * Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
	 */
	icon?: string | null;
	/**
	 * Stable id for this section within the plugin (namespaced into the shell's
	 * section key as `plugin:<pluginId>:<id>`).
	 */
	id: string;
	/**
	 * Optional placement hint among the sidebar sections (lower = higher up).
	 */
	order?: number | null;
	/**
	 * The opaque section spec (source/itemTarget/itemActions/create). Interpreted by
	 * the desktop renderer, never by Core. Absent = a header with no rows.
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Header label shown in the sidebar and the Customize dialog.
	 */
	title: string;
}
/**
 * A server-side chat turn hook contributed by a plugin. The `code` is a JS body
 * run in the plugin sandbox with `ctx` (the turn context) and `host` (the
 * capability bridge: `host.sideModel`, `host.storage`, `host.log`) in scope; it
 * returns a directive (`{kind:"none"}` | `{kind:"note",text}` |
 * `{kind:"continue",text}`). See Core's `plugin_host`.
 */
export interface TurnHookContribution {
	/**
	 * The JS hook body executed in the sandbox (returns a directive).
	 */
	code: string;
	/**
	 * Stable id for this hook (for logging/audit), unique within the plugin.
	 */
	id: string;
	/**
	 * Optional cheap pre-gate. When present, Core's `plugin_host` evaluates it
	 * in Rust **before** spawning the sandbox, so an idle hook (e.g. double-check
	 * with its toggle off, or goal with no active condition) costs a flag/prefix
	 * check or one KV read instead of a Deno process. This is what makes it safe
	 * to ship these hooks **enabled by default** on every surface. Absent (or all
	 * fields empty) → the hook always runs, preserving prior behaviour.
	 */
	match?: HookMatch | null;
	/**
	 * The turn boundary this hook fires on. Today only `"post_assistant_turn"`.
	 */
	on: string;
}
/**
 * A declarative pre-gate for a [`TurnHookContribution`]. The conditions are
 * OR-ed: the hook runs if **any** present condition matches. An empty match
 * (every field default) means "always run". Kept intentionally small — richer
 * matching belongs inside the hook JS, this only exists to skip the sandbox
 * spawn on turns where the hook provably cannot act.
 */
export interface HookMatch {
	/**
	 * Run if the last user message (trimmed) starts with any of these prefixes,
	 * e.g. `["/goal"]`. This is how a slash-command hook wakes up.
	 */
	commands?: string[];
	/**
	 * Run only if the request set this composer flag true (`ctx.flags[flag]`),
	 * e.g. `"io.ryu.double-check"`.
	 */
	flag?: string | null;
	/**
	 * Run if the plugin has stored state for this conversation (its default KV
	 * namespace has a value keyed by `conversation_id`), e.g. an active goal.
	 */
	stateful?: boolean;
	/**
	 * Run if the tool being called (`ctx.tool_name`) matches any of these
	 * patterns — for `pre_tool_use` / `post_tool_use` hooks. A pattern is a tool
	 * id with optional leading/trailing `*` wildcards (`"*"` = every tool,
	 * `"bash*"` = ids starting with `bash`). This keeps a tool-firewall hook from
	 * spawning the sandbox on every unrelated tool call.
	 */
	tools?: string[];
}
/**
 * One **declarative view** contribution (the Raycast tier — see [`Contributes::views`]).
 *
 * A typed envelope around an opaque `spec`: Core stores it verbatim, tags it with
 * the owning `plugin` id at `GET /api/plugins/contributions`, and forwards it to the
 * surface shell, which maps `view` + `spec` to native components. The `spec` shape is
 * owned by the shared TS vocabulary (`@ryu/app-host/views`), NOT by this contract, so
 * adding a view kind is a renderer change, never a Core change.
 */
export interface ViewContribution {
	/**
	 * Stable id for this view within the plugin (route/anchor key, unique per plugin).
	 */
	id: string;
	/**
	 * The DATA payload for the view (items/columns/actions/fields/…). Opaque to Core
	 * — the shared renderer interprets it per the `view` kind. Absent = an empty view.
	 */
	spec?: {
		[k: string]: unknown;
	};
	/**
	 * Optional human-facing title (tab label / palette entry). Absent = the shell
	 * derives one from the view kind or the plugin name.
	 */
	title?: string | null;
	/**
	 * The vocabulary member this view renders as — the discriminant the per-surface
	 * renderer switches on (`"list-detail"`, `"data-table"`, `"form"`,
	 * `"action-panel"`, `"filter-bar"`, `"empty-state"`, `"stat-card-row"`). Opaque
	 * to Core; an unknown kind is passed through so a newer shell can render it.
	 */
	view: string;
}
/**
 * One app-widget contribution (Ryu Apps). Binds the tool that renders the widget
 * to its HTML template. `ui_entry` is the source entry the SDK `ryu pack` builds
 * into the self-contained HTML for third-party apps; built-in apps serve HTML
 * from the in-process provider and leave it unset.
 */
export interface WidgetContribution {
	/**
	 * Default display mode (`inline` | `fullscreen` | `pip`).
	 */
	default_display_mode?: string;
	/**
	 * Widget MIME dialect (default `text/html+skybridge`).
	 */
	mime?: string;
	/**
	 * The fully-qualified tool id whose result renders this widget.
	 */
	tool_id: string;
	/**
	 * Source entry (e.g. `src/apps/checklist/index.tsx`) for `ryu pack`.
	 */
	ui_entry?: string | null;
	/**
	 * `ui://widget/<slug>.html` — the widget resource uri.
	 */
	uri: string;
}
/**
 * `engines` block — the required Ryu version, mirroring VS-Code's
 * `engines.vscode`. `ryu` is a semver **requirement** string.
 */
export interface EnginesReq {
	/**
	 * Semver requirement the running Core version must satisfy (e.g. `">=0.3.0"`,
	 * `"^1.2"`). Parsed as a [`semver::VersionReq`]; an unparseable value or an
	 * unsatisfied requirement causes the loader to reject the manifest.
	 */
	ryu: string;
}
/**
 * One declarative **stdio MCP server** a plugin registers (see
 * [`PluginManifest::mcp_servers`]).
 *
 * This is the manifest-side, dependency-free mirror of Core's runtime
 * `McpServerConfig`: pure data (schemars/serde only) so it can live in
 * kernel-contracts, with Core lowering it into its registry type on enable. A
 * server is spawned per request as `command args…` (stdio); `command_env` lets
 * the manifest name an env var Core resolves to an absolute binary path
 * (e.g. `RYU_GHOST_BIN`) so a downloaded `~/.ryu/bin` binary can override the
 * bare `command`.
 */
export interface McpServerDecl {
	/**
	 * Arguments passed to the command.
	 */
	args?: string[];
	/**
	 * Executable to spawn (e.g. `npx`, an absolute path, or a `~/.ryu/bin` name).
	 */
	command: string;
	/**
	 * Optional env var whose value, when set, OVERRIDES [`command`] with an
	 * absolute binary path. Lets a plugin ship a bare `command` that Core repoints
	 * at a profile-specific downloaded binary. Absent ⇒ use `command` verbatim.
	 *
	 * [`command`]: McpServerDecl::command
	 */
	command_env?: string | null;
	/**
	 * Optional human description for the MCP listing endpoint.
	 */
	description?: string | null;
	/**
	 * When false, the server is registered but skipped by list/call. Defaults to
	 * true so a bare `{ command }` entry just works.
	 */
	enabled?: boolean;
	/**
	 * Extra environment variables for the server process.
	 */
	env?: {
		[k: string]: string;
	};
}
/**
 * The single, typed, **deny-by-default** permission set a plugin manifest
 * declares, lowered by Core to every sandbox backend.
 *
 * This is the one grammar that replaces three historically-disjoint ones:
 * the wasmtime/Docker [`crate`]-external `SandboxCapabilities` (typed but
 * unreachable from a manifest), the Deno PTC's hardcoded zero-allow-flag spawn,
 * and the opaque grant strings. A manifest declares ONE `permissions` block and
 * Core lowers it to WASI preopens, Docker mount/network flags, or Deno
 * `--allow-*` flags as appropriate.
 *
 * **Every field defaults to empty/false — the zero value is deny-all.** A missing
 * `permissions` block (or an explicit `{}`) is byte-for-byte the same posture as
 * today's zero-permission sandbox, which is what preserves the existing live
 * deny-all tests.
 */
export interface PermissionSet {
	/**
	 * Whether the sandboxed code may spawn child processes. `false` (default) =
	 * no subprocess execution. Lowers to Deno's `--allow-run`; the wasmtime/Docker
	 * lowering has no subprocess channel to open, so this is a no-op there (a WASI
	 * module cannot fork, and the Docker exec is a single fixed argv).
	 */
	child_process?: boolean;
	fs?: FsPermissions;
	/**
	 * Outbound network permission. `false`/absent (default) = no network; `true` =
	 * all hosts; a list of `host[:port]` entries = only those hosts (the shape
	 * Deno's `--allow-net` supports). See [`NetworkPermission`].
	 */
	network?: boolean | string[];
	/**
	 * **Declaration-only** in v1: the registry tool ids this plugin's sandboxed
	 * code may call through the stdio `tools.*` bridge. Tools are brokered over
	 * stdout/stdin by Core (never an OS capability), so this does NOT lower to any
	 * `--allow-*` flag; it records intent and is a clean future extension for the
	 * `SandboxToolInvoker` allowlist. Empty (default) records no extra tool intent.
	 */
	tool?: string[];
}
/**
 * Filesystem read/write path allowlists. Empty = no FS access.
 */
export interface FsPermissions {
	/**
	 * Absolute paths the sandbox may **read**. Empty = no read access.
	 */
	read?: string[];
	/**
	 * Absolute paths the sandbox may **write**. Empty = no write access.
	 */
	write?: string[];
}
/**
 * One **provided capability** entry (in [`PluginManifest::provides`]).
 *
 * Binds an abstract capability name to a concrete serving surface on THIS
 * manifest: the local `sidecar` name whose declared HTTP `route` implements the
 * capability, plus the `grant` a consumer must hold to invoke it. The broker
 * routes a consumer's `/api/host/capability/<cap>` call to this sidecar's route
 * using the *provider's* minted token — the consumer never sees it.
 */
export interface ProvidesEntry {
	/**
	 * The capability name this plugin serves (e.g. `"rag"`). Consumers match on
	 * this against their [`Requires::capabilities`].
	 */
	capability: string;
	/**
	 * The grant a consumer must hold (Gateway-approved) to invoke this capability
	 * via the broker. Absent = no extra grant beyond declaring the edge.
	 */
	grant?: string | null;
	/**
	 * The proxied sub-path (on the named sidecar's [`crate::schema::HttpProxySpec`])
	 * the broker forwards capability calls to (e.g. `"/rag/query"`). The loader
	 * cross-validates that the named sidecar declares a matching route.
	 */
	route?: string | null;
	/**
	 * The local `name` of one of this manifest's declared `sidecars` that serves
	 * the capability. The loader cross-validates it exists. Absent = an in-process
	 * capability with no dedicated sidecar (the broker declines to proxy it).
	 */
	sidecar?: string | null;
	/**
	 * The capability's own semver version (independent of the plugin version), so
	 * a consumer's [`CapabilityReq::min_version`] floor can be checked against the
	 * capability contract rather than the app release.
	 */
	version: string;
}
/**
 * `requires` block — the plugin's **plugin-to-plugin** dependencies.
 *
 * This is the npm-shaped edge that lets the app decompose into a minimal kernel
 * plus features: a plugin declares the other plugins it needs, and the lifecycle
 * (Core's `plugins::graph`) resolves them into a topological enable order.
 *
 * Distinct from [`EnginesReq`], which constrains plugin→**Core** (the engine
 * version). `requires` constrains plugin→**plugin**.
 *
 * Absent (the default, and the case for every manifest that predates this field)
 * means *no dependencies* — the plugin enables standalone exactly as before.
 */
export interface Requires {
	/**
	 * Other plugins that must be installed (and are auto-enabled, in dependency
	 * order) before this one can enable.
	 */
	apps?: AppDependency[];
	/**
	 * **Capabilities** this plugin requires — the layered, provider-agnostic edge
	 * (`requires: [rag]`) that the capability broker resolves to a concrete
	 * provider app at bind time. Distinct from [`apps`]: an `apps` edge names a
	 * specific plugin id; a `capabilities` edge names an abstract capability and
	 * lets the binding registry pick (or the user override) which enabled provider
	 * serves it. Each is lowered to an app-id graph edge once bound, so the
	 * topological enable/disable/cycle machinery is shared. Empty for the common
	 * case.
	 *
	 * [`apps`]: Requires::apps
	 */
	capabilities?: CapabilityReq[];
	/**
	 * Permission grants implied by the dependencies. Declaration only — the
	 * Gateway remains the sole authority on what a grant *allows* (Core decides
	 * what runs; the Gateway decides what is permitted).
	 */
	grants?: string[];
}
/**
 * A single plugin-to-plugin dependency edge.
 */
export interface AppDependency {
	/**
	 * The `id` of the plugin this one depends on.
	 */
	id: string;
	/**
	 * Optional **minimum** version the dependency must satisfy.
	 *
	 * A bare version (`"1.2.0"`) is a *minimum*, i.e. `">=1.2.0"` — deliberately
	 * NOT semver's default caret (`^1.2.0`), which would reject `2.0.0`. Explicit
	 * comparator syntax (`">=1.2, <2"`, `"^1.2"`, `"~1.2"`) is honoured verbatim.
	 * See [`parse_min_version`], the single parser both validation and resolution
	 * use.
	 */
	min_version?: string | null;
}
/**
 * One **required capability** edge (in [`Requires::capabilities`]).
 *
 * Names an abstract capability plus an optional minimum *capability* version. The
 * version floor is checked at bind time against the bound provider's
 * [`ProvidesEntry::version`] — NOT against the provider plugin's own semver — so a
 * lowered graph edge carries no `min_version` (the app-version gate would compare
 * the wrong number). See the capability broker in Core.
 */
export interface CapabilityReq {
	/**
	 * The capability name (e.g. `"rag"`, `"tts"`). Matched against a provider's
	 * [`ProvidesEntry::capability`].
	 */
	capability: string;
	/**
	 * Optional minimum **capability** version the bound provider must satisfy
	 * (bare `"1.2.0"` = `">=1.2.0"`, via [`parse_min_version`]). Absent = any
	 * version of the capability is acceptable.
	 */
	min_version?: string | null;
}
/**
 * A single Runnable entry inside a `manifest.json` manifest.
 *
 * Each entry carries the identity fields from [`crate::runnable::RunnableMeta`]
 * plus an optional typed config blob. The `kind` field drives which config shape
 * is expected; validation via [`validate_runnable`] checks that
 * required-per-kind fields are present.
 */
export interface RunnableEntry {
	/**
	 * Per-kind configuration. Some kinds (e.g. `agent`) treat this as
	 * optional (sensible defaults apply); others (e.g. `tool`, `workflow`)
	 * require it. [`validate_runnable`] enforces the rules.
	 */
	config?: {
		[k: string]: unknown;
	};
	/**
	 * Stable unique identifier within this app (e.g. `"tool-web-search"`).
	 */
	id: string;
	/**
	 * Discriminant that determines which per-kind config struct is required.
	 */
	kind: "agent" | "workflow" | "tool" | "skill" | "companion" | "channel" | "engine" | "policy";
	/**
	 * Human-readable display name.
	 */
	name: string;
}
/**
 * code surface the Gateway must permit before it runs.
 */
export interface ExternalRuntimeConfig {
	/**
	 * Assets to fetch into `~/.ryu` before first run.
	 */
	assets?: AssetSpec[];
	/**
	 * The module/entrypoint to run (e.g. `"ryu_tts"` → `python -m ryu_tts`).
	 */
	entry: string;
	/**
	 * Environment variables layered onto the runtime process at spawn. Values may
	 * use `${RYU_DIR}` — expanded to the Core data dir (`~/.ryu`) at spawn — so a
	 * runtime can point caches/outputs at Core-owned paths without hardcoding an
	 * absolute path in the (portable) manifest. Nothing else is interpolated.
	 */
	env?: {
		[k: string]: string;
	};
	/**
	 * Health-check path on the runtime's server (e.g. `"/health"`).
	 */
	health_path?: string | null;
	/**
	 * Runtime kind. `"python"` is the only provisionable kind today; others are
	 * accepted (round-trip) but provisioning returns an "unsupported" error.
	 *
	 * Defaults to `"python"` so this config can be nested inside the internally
	 * `#[serde(tag = "kind")]`-tagged [`SidecarProcess::Python`] variant: there the
	 * outer enum consumes the `"kind"` key as its discriminant, so the inner field
	 * would otherwise be reported missing — the classic internally-tagged collision.
	 * Standalone use still round-trips an explicit `kind`.
	 */
	kind?: string;
	/**
	 * Port the runtime's HTTP server binds to (adopt-or-spawn check).
	 */
	port?: number | null;
	/**
	 * Optional env var the Python child reads for its **bind port**. When set, Core
	 * injects `<port_env> = profile-shifted([`SidecarSpec::port`])` at spawn, so the
	 * child binds the same profile-aware port Core health-checks + proxies to — the
	 * Python-sidecar analogue of [`LocalProcessSpec::port_env`] (without it a static
	 * port env collides across concurrent Core profiles).
	 */
	port_env?: string | null;
	/**
	 * Optional pyproject *extra* to install (`pip install -e ".[<extra>]"`).
	 */
	pyproject_extra?: string | null;
	/**
	 * Optional Python version hint (e.g. `"3.11"`). Advisory.
	 */
	python_version?: string | null;
	/**
	 * pip requirement specs to install into the venv.
	 */
	requirements?: string[];
	/**
	 * Optional **source archive** to extract into the runtime dir before the venv
	 * is built. Needed when the entry module is a *first-party package the plugin
	 * ships* (not on PyPI): a `pip install -e ".[extra]"` needs the package's
	 * `pyproject.toml` + sources on disk first. Single-file `assets` cannot deliver
	 * a source tree; this does. Omit for a pure-PyPI runtime.
	 */
	source?: SourceArchiveSpec | null;
}
/**
 * A single asset an external runtime needs, fetched before first run. Either a
 * direct https URL or an `hf:<owner>/<repo>/<path>` reference; `dest_under_ryu`
 * is the relative directory beneath `~/.ryu` where it lands (Core-owned) — the
 * filename is derived from the source's last path segment.
 */
export interface AssetSpec {
	/**
	 * Destination directory relative to `~/.ryu` (e.g. `"models/hf"`); the
	 * fetched file lands at `~/.ryu/<dest_under_ryu>/<filename>`. Must be a
	 * traversal-safe relative path (no `..`, not absolute).
	 */
	dest_under_ryu: string;
	/**
	 * Optional SHA-256 for checksum verification (direct-URL assets).
	 */
	sha256?: string | null;
	/**
	 * A direct **https** URL, or an `hf:<owner>/<repo>/<path>` reference to a
	 * single file on the Hub. A repo-only `hf:<owner>/<repo>` ref (no file path)
	 * is **not** provisionable yet — full-repo snapshot needs Hub tree-listing
	 * that is not wired into the provisioner. The provisioner
	 * (`crate::sidecar::external_runtime`) rejects `http://` and other schemes.
	 */
	source: string;
}
/**
 * A source-tree archive an external runtime extracts into its runtime dir before
 * provisioning (venv + `pip install -e .`). Distinct from [`AssetSpec`], which
 * fetches a *single file* into `~/.ryu`; this delivers a whole package tree the
 * plugin owns.
 */
export interface SourceArchiveSpec {
	/**
	 * Archive format: `"tar.gz"` or `"zip"`. Extracted whole-tree into the runtime
	 * dir so the package's `pyproject.toml` lands at its root.
	 */
	format: string;
	/**
	 * Optional lower-case-hex SHA-256 of the archive; when present the download is
	 * verified and re-fetched on mismatch (fail-closed).
	 */
	sha256?: string | null;
	/**
	 * Direct **https** URL to the archive. Non-https is rejected by the SSRF egress
	 * screen at download time.
	 */
	url: string;
}
/**
 * A declarative **managed sidecar** a plugin may declare: a long-running child
 * process Core owns end-to-end (download/provision → spawn → health-check →
 * stop), registered into the Core `SidecarManager` on enable so it rides the
 * *same* managed lifecycle (health monitor + resource sampler +
 * `/api/sidecar/status`) as a built-in sidecar.
 *
 * This is the **app ⇄ sidecar bridge**: it lets a capability sidecar (ghost,
 * shadow, a TTS engine, …) be a fully manifest-defined app instead of hardcoded
 * Rust, and lets a third-party app ship its own process under a Gateway grant.
 * Infra sidecars (llama.cpp, the gateway, embeddings) stay Core substrate and are
 * deliberately NOT expressible here.
 *
 * The process is obtained one of two ways ([`SidecarProcess`]): a downloaded
 * **binary**, or a **Python** runtime (reusing [`ExternalRuntimeConfig`] — venv +
 * pip + assets). Both are gated at enable by the `sidecar:process` grant; nothing
 * is hardcoded — the binary URL, args, env, port, and health path are all data.
 */
export interface SidecarSpec {
	/**
	 * Health-check path on the process's server (default `"/health"`). A GET to
	 * `http://127.0.0.1:<port><health_path>` returning 2xx marks it healthy.
	 */
	health_path?: string;
	/**
	 * Optional **host-API** declaration: the subset of the owning plugin's approved
	 * grants the sidecar *process* may exercise via an authenticated callback into
	 * Core (`/api/host/*`, bearer = the plugin's minted `RYU_EXT_TOKEN`). Absent =
	 * the sidecar may not call back into Core at all (deny-all). Additive.
	 */
	host_api?: HostApiSpec | null;
	/**
	 * Optional **HTTP proxy** declaration: when present, Core exposes a public
	 * reverse-proxy front (`/api/ext/<plugin_id>/*`) onto this sidecar, so a
	 * manifest-declared sidecar becomes a full first-class *app* reachable by any
	 * client — the generic form of the hand-coded `ryu-mail` proxy. Absent = the
	 * sidecar is an internal capability with no external HTTP surface (only Core's
	 * own health probe reaches it). Additive: existing sidecars get `None`.
	 */
	http?: HttpProxySpec | null;
	/**
	 * **Idle-stop timeout**, in seconds — scale-to-zero for this sidecar. When set,
	 * Core stops the process after it has served no request for this long (and has
	 * none in flight); the next proxy/broker hit wakes it again (see [`lazy`]). Must
	 * be `>= 30` (a shorter window churns the process). Absent = never idle-stopped
	 * by manifest declaration (the operator-level [`RYU_SIDECAR_IDLE_SECS`] env can
	 * still opt a sidecar in). Additive; independent of [`lazy`] — an eager sidecar
	 * may declare an idle timeout and will then wake-on-demand after a reap.
	 *
	 * [`lazy`]: SidecarSpec::lazy
	 * [`RYU_SIDECAR_IDLE_SECS`]: the manager's env-seeded idle config.
	 */
	idle_stop_secs?: number | null;
	/**
	 * **Lazy activation** — spawn-on-first-use instead of at plugin-enable. When
	 * `true` the sidecar is *registered* (claims its port, appears in
	 * `/api/sidecar/status` as not-running) at enable but its process is NOT started
	 * until the first proxy/broker hit wakes it on demand; a bounded health-wait
	 * warms it before the request is forwarded. `false` (the default) keeps the
	 * eager behaviour every existing manifest has: started at enable. Additive.
	 */
	lazy?: boolean;
	/**
	 * Local name, unique within the plugin. Namespaced to `<plugin_id>/<name>` at
	 * registration so it never collides with a built-in sidecar or another
	 * plugin's. Must be a safe single path segment (no `/`, `\`, `..`, or NUL).
	 */
	name: string;
	/**
	 * TCP port the process's HTTP server binds to, used to build the health-check
	 * URL. The plugin is responsible for choosing a free port — there is **no port
	 * registry in v1**, so a collision with a built-in (e.g. llama.cpp on 8080) is
	 * the plugin author's responsibility to avoid.
	 */
	port: number;
	/**
	 * How Core obtains and runs the process.
	 */
	process: BinarySpec | ExternalRuntimeConfig1 | LocalProcessSpec | NodeProcessSpec;
	/**
	 * Optional **model-provider** declaration: when present, this sidecar serves an
	 * OpenAI-compatible endpoint and Core registers it as a selectable provider once
	 * the process reports healthy, then deregisters it when the plugin is disabled or
	 * uninstalled. This is what makes a third-party *auth bridge* possible without a
	 * Core change: the plugin performs its own login/refresh, serves `/v1`, and
	 * declares that fact here. Absent = the sidecar is not a model provider.
	 *
	 * A sidecar cannot self-register: it holds only `RYU_EXT_TOKEN` (scoped to the
	 * ext-proxy hop and `/api/host/*`), and the host-RPC vocabulary has no
	 * provider-registration method. Registration is therefore Core-side, driven by
	 * this declaration.
	 */
	provides_provider?: ProviderRegistrationSpec | null;
}
/**
 * Declares the host-API grant subset a sidecar *process* may exercise via the
 * authenticated `/api/host/*` callback into Core. The listed grants are the ceiling;
 * Core still intersects them with the plugin's *approved* grants (post-Gateway
 * validation) at call time, so a manifest can never widen its own authority here.
 */
export interface HostApiSpec {
	/**
	 * The grant strings (same vocabulary as `permission_grants`, e.g.
	 * `"hook:side-model"`) the sidecar backend may exercise via `/api/host/*`.
	 */
	grants?: string[];
}
/**
 * Declares the reverse-proxy front Core mounts onto a [`SidecarSpec`]. This is the
 * **data** form of what `apps/core/src/sidecar/mail.rs` hand-codes: the exact set of
 * external routes and their per-route auth posture. Core rejects any request whose
 * sub-path is not one of [`routes`] (404), preserving mail's exact-route safety as a
 * declaration instead of a hardcoded router.
 *
 * [`routes`]: HttpProxySpec::routes
 */
export interface HttpProxySpec {
	/**
	 * Maximum request body Core will buffer and forward, in bytes. Absent ⇒ Core's
	 * conservative default. Caps the proxy's memory exposure per request.
	 */
	max_body_bytes?: number | null;
	/**
	 * Optional path prefix prepended to the forwarded sub-path when Core builds the
	 * upstream URL on the sidecar (e.g. `mount = "/api/mail"` turns an external
	 * `/api/ext/<id>/status` into an upstream `/api/mail/status`). Absent/empty ⇒
	 * the sub-path after `/api/ext/<plugin_id>` is forwarded verbatim. Must start
	 * with `/` when present.
	 */
	mount?: string | null;
	/**
	 * Optional **public mount** — a stable, externally-committed URL prefix under
	 * which Core ALSO exposes this sidecar's routes, instead of only the generic
	 * `/api/ext/<plugin_id>/*` catch-all (e.g. `"/api/mail"` for a mail app whose
	 * inbound-webhook URL is baked into an external forwarder). Registered at
	 * `create_router` build time and only honoured for **built-in** manifests
	 * (axum routers are immutable after serve, so a runtime-installed third-party
	 * app cannot claim a custom prefix — it keeps `/api/ext/<id>/*`). Absent = no
	 * public mount (the common case). The routes + per-route auth are the SAME
	 * [`routes`] list; this only changes the public prefix they answer on.
	 *
	 * [`routes`]: HttpProxySpec::routes
	 */
	public_mount?: string | null;
	/**
	 * The exact set of proxied routes. Each entry's [`RouteSpec::path`] is matched
	 * against the incoming sub-path (the segment after `/api/ext/<plugin_id>`),
	 * supporting `:param` and trailing `*rest` wildcards. A request whose sub-path
	 * matches **none** of these is refused with 404 — undeclared paths are never
	 * forwarded (the security property that makes this a safe generalization of the
	 * mail proxy's fixed route list).
	 */
	routes?: RouteSpec[];
}
/**
 * One declared proxied route: a path pattern plus its auth posture.
 */
export interface RouteSpec {
	/**
	 * Auth posture for this route. Defaults to [`RouteAuth::Protected`] (secure by
	 * default): the request must carry the node bearer exactly as any other
	 * protected Core route. `public` opts a route out (e.g. an HMAC-authed inbound
	 * webhook whose external caller cannot hold the node token).
	 */
	auth?: "protected" | "public";
	/**
	 * Path pattern for the sub-path after `/api/ext/<plugin_id>` (must start with
	 * `/`). Supports `:param` (matches one non-empty segment) and a trailing
	 * `*rest` (matches the remainder), mirroring axum/matchit patterns so a
	 * sidecar's REST routes (`/inboxes/:id`) can be declared faithfully.
	 */
	path: string;
}
/**
 * A single downloaded executable: fetched (checksum-verified) into the
 * plugin's `bin/` dir, made executable, then spawned with `args` + `env`.
 */
export interface BinarySpec {
	kind: "binary";
}
/**
 * A Python runtime: the existing external-runtime provisioner (venv + pip +
 * assets) builds the environment, then `python -m <entry>` is spawned.
 * Reuses [`ExternalRuntimeConfig`] verbatim (its `port`/`health_path` are
 * ignored here — the [`SidecarSpec`]'s own fields drive the health check).
 */
export interface ExternalRuntimeConfig1 {
	kind: "python";
}
/**
 * A binary **already present on the host** — a sibling Ryu ships alongside Core
 * (e.g. `ryu-mail`), or something on `PATH`. Spawned directly with **no download**.
 * This is the escape hatch for first-party sidecars built in the same repo, which
 * have no release-artifact URL. Not for third-party apps (they should declare a
 * downloadable [`Binary`]).
 *
 * [`Binary`]: SidecarProcess::Binary
 */
export interface LocalProcessSpec {
	kind: "local";
}
/**
 * A **managed JavaScript backend** — the extension-host runtime (RFC Option B).
 * Core spawns a small first-party bootstrap (embedded in the binary) under `bun`
 * (preferred) or `node`, which loads the plugin's declared `entry` module and
 * calls its exported `activate(context)`; the module may register an HTTP request
 * handler that the `/api/ext/<id>/*` proxy forwards to. The `entry` bundle rides
 * as the owning manifest's `backend_code` payload (mirroring `ui_code`) and is
 * written to the plugin dir + integrity-checked against `backend_sha256` at spawn.
 * Because it is still a [`SidecarSpec`] it inherits the whole managed lifecycle
 * (lazy/wake, idle-stop, health monitor, PATH cap-shims, per-plugin `RYU_EXT_*`
 * token, `RouteAuth` proxying). Gated by the experimental-plugin-runtime flag and,
 * for Community-tier plugins, by the `sidecar:process` grant exactly like a binary.
 */
export interface NodeProcessSpec {
	kind: "node";
}
/**
 * Declares that a [`SidecarSpec`] serves an OpenAI-compatible model endpoint Core
 * should register as a provider while the sidecar is healthy.
 *
 * Security posture: the declared [`id`] is validated against the built-in provider
 * table at registration and a collision is REFUSED, never merged. Without that guard
 * a plugin could claim a built-in id (`openai-codex`, `anthropic`) and silently
 * redirect the user's subscription traffic — and their live bearer token — to an
 * attacker-controlled `baseUrl`. Core also stamps [`OWNER_FIELD`] into the written
 * entry so deregistration can only ever remove an entry this plugin created.
 *
 * [`id`]: ProviderRegistrationSpec::id
 * [`OWNER_FIELD`]: crate::schema::PROVIDER_OWNER_FIELD
 */
export interface ProviderRegistrationSpec {
	/**
	 * Pi `api` type the endpoint speaks. Defaults to `"openai-completions"`.
	 */
	api?: string | null;
	/**
	 * Path prefix appended to `http://127.0.0.1:<port>` to form the provider's
	 * `baseUrl`. Defaults to `"/v1"`.
	 */
	base_path?: string | null;
	/**
	 * Provider id as it appears in the model picker. Must not collide with a built-in
	 * provider id, and must be a safe single token (lowercase alphanumerics, `-`, `_`).
	 */
	id: string;
	/**
	 * Human-readable label for the picker. Defaults to [`id`] when absent.
	 *
	 * [`id`]: ProviderRegistrationSpec::id
	 */
	label?: string | null;
	/**
	 * Optional model ids to seed the entry with, for an endpoint whose `GET /models`
	 * discovery is unavailable or slow. Absent = rely on discovery.
	 */
	models?: string[];
}
/**
 * One [`PluginManifest::surfaces`] entry: the support level plus an optional UI
 * descriptor the surface shell resolves (opaque here — pure data).
 */
export interface SurfaceEntry {
	/**
	 * Terminal subcommands this app contributes to the `cli` surface (the TUI's
	 * `ryu <app> <cmd>` dispatcher). Only meaningful on the `cli` surface entry;
	 * ignored on other surfaces. Empty/absent = the app contributes no commands.
	 */
	commands?: CliCommandSpec[];
	/**
	 * How much of the plugin this surface supports.
	 */
	support?: "full" | "limited" | "list" | "commands" | "none";
	/**
	 * Optional surface-specific UI descriptor (bundle id, mount point, …),
	 * interpreted by the surface's app host. Opaque to the contract.
	 */
	ui?: {
		[k: string]: unknown;
	};
}
/**
 * One terminal subcommand an app contributes to the `cli` surface (the TUI's
 * `ryu <app> <cmd>` dispatcher). Routed through Core's `ext_proxy` to the app's
 * sidecar: Core forwards `<method> /api/ext/<plugin_id><path>`. `path` MUST be a
 * route the app's sidecar declares in `http.routes`, or the proxy 404s.
 */
export interface CliCommandSpec {
	/**
	 * HTTP method for the `ext_proxy` call. Absent = `POST`.
	 */
	method?: string | null;
	/**
	 * Subcommand token, e.g. `status` in `ryu mail status`.
	 */
	name: string;
	/**
	 * Sub-path appended after `/api/ext/<plugin_id>`. Validated by
	 * [`validate_cli_command_path`] at manifest load: it MUST be an absolute
	 * (`/`-leading), traversal-free sub-path — no `..` segment in any form — so it
	 * cannot escape the plugin's proxy scope when a URL parser normalizes it.
	 */
	path: string;
	/**
	 * One-line help shown in `ryu <app>` / `ryu <app> --help`.
	 */
	summary?: string | null;
}
