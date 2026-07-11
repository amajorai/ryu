// The `app.meta.ts` schema (spec §5.1). Each widget app's `app.meta.ts` is the
// SINGLE SOURCE OF TRUTH for its identity + tool surface: `scripts/embed.ts` reads
// these to codegen the Rust `AppBundle`/`AppToolMeta` entries in
// `apps/core/src/sidecar/mcp/apps/generated.rs`. A widget builder edits only
// `index.tsx` + the component; the metadata lives here.

/** One tool a widget app exposes. Tool id on the wire is `<server>__<name>`. */
export interface AppToolMetaDef {
	/** Short tool name (composed into `<server>__<name>` for the wire id). */
	name: string;
	/** JSON Schema for the tool's arguments. */
	inputSchema: Record<string, unknown>;
	/** Whether the WIDGET may invoke this tool via `callTool` (companion writes).
	 *  `render`/read tools are `false`; mutation tools are `true`. */
	widgetAccessible: boolean;
	/** Human description surfaced to the model / catalog. */
	description?: string;
	/** Streaming label while the tool runs (Apps-SDK `toolInvocation.invoking`). */
	invoking?: string;
	/** Completion label (Apps-SDK `toolInvocation.invoked`). */
	invoked?: string;
}

/** The metadata for one widget app. */
export interface AppMeta {
	/** URL/file-safe id; the bundle is emitted as `<slug>.html`. */
	slug: string;
	/** MCP server namespace that owns this app's tools. */
	server: string;
	/** Display name. */
	name: string;
	/** The widget resource uri, `ui://widget/<slug>.html`. */
	uri: string;
	/** Ship enabled on install. */
	defaultOn: boolean;
	/** Default presentation. */
	displayMode: "inline" | "fullscreen" | "pip";
	/** Permission grants this app declares (e.g. `chat.sendFollowUp`). */
	grants?: string[];
	/** The tools this app exposes. */
	tools: AppToolMetaDef[];
}
