/**
 * defineTool — factory for Runnable tools.
 *
 * A tool is a stateless function invoked by an agent or workflow step.
 * It accepts a typed schema (Zod-style field definitions) that is converted
 * to a JSON Schema object compatible with Core's `ToolInfo.schema` shape
 * (apps/core/src/sidecar/adapters/mod.rs:66-71).
 *
 * Input is validated against the schema at run() time; invalid input throws
 * a descriptive Error before the tool body executes.
 *
 * Tools do NOT require model calls and therefore do not need `ctx.gateway`
 * to be present, but the context is still injected so tools can optionally
 * call gateway.chat() when they need model assistance.
 */

import type { RunnableMeta } from "../manifest.ts";
import type { Runnable, RunnableContext } from "./runnable-types.ts";

// ── JSON Schema types ─────────────────────────────────────────────────────────

/**
 * A single JSON Schema property descriptor — the subset required by Core's
 * `ToolInfo.schema` field and the OpenAI function-calling format.
 */
export interface JsonSchemaProperty {
	/** Human-readable description surfaced to the model. */
	description?: string;
	/** Allowed enum values. */
	enum?: unknown[];
	/** Array item schema (required when type is "array"). */
	items?: JsonSchemaProperty;
	/** Nested object properties (used when type is "object"). */
	properties?: Record<string, JsonSchemaProperty>;
	/** Required keys list (used when type is "object"). */
	required?: string[];
	/** JSON Schema type string. */
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
}

/**
 * Zod-style schema descriptor for a tool's input.
 *
 * Keys are field names; values describe their JSON Schema shape.  Required
 * fields are listed separately under `required`.
 *
 * This intentionally mirrors the shape that `ToolInfo.schema` expects in
 * `apps/core/src/sidecar/adapters/mod.rs` so a `defineTool` output can be
 * forwarded to Core without transformation.
 */
export interface ToolSchema {
	/** Field definitions. */
	properties: Record<string, JsonSchemaProperty>;
	/** Names of fields that must be present in the input. */
	required?: string[];
	/** Type is always "object" for a tool's top-level input schema. */
	type: "object";
}

// ── Options ───────────────────────────────────────────────────────────────────

/** Options accepted by `defineTool`. */
export interface ToolOptions<TInput extends Record<string, unknown>, TOutput> {
	/** Stable unique identifier (e.g. "tool-web-search"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/**
	 * The tool's run implementation.
	 *
	 * Called only after input validation passes.  Model calls are optional but
	 * must go through `ctx.gateway` if used.
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
	/** JSON Schema describing the tool's input — used for input validation and Core ToolInfo. */
	schema: ToolSchema;
}

// ── Internal: input validation ────────────────────────────────────────────────

/**
 * Validate `input` against `schema`.
 *
 * Throws a descriptive `Error` naming the first failing field.  This mirrors
 * the validation behaviour of `PluginManifestSchema.safeParse` used elsewhere in
 * the SDK — consistent error handling, no silent fallback.
 */
function validateInput(
	input: unknown,
	schema: ToolSchema,
	toolId: string
): void {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error(
			`[ryu-sdk] Tool "${toolId}" input must be an object, got ${JSON.stringify(input)}`
		);
	}

	const record = input as Record<string, unknown>;

	for (const requiredKey of schema.required ?? []) {
		if (!(requiredKey in record)) {
			throw new Error(
				`[ryu-sdk] Tool "${toolId}" input missing required field "${requiredKey}"`
			);
		}
	}

	for (const [key, prop] of Object.entries(schema.properties)) {
		if (!(key in record)) {
			continue; // optional field — skip
		}
		const value = record[key];
		if (!checkType(value, prop.type)) {
			throw new Error(
				`[ryu-sdk] Tool "${toolId}" input field "${key}" expected type "${prop.type}", ` +
					`got ${JSON.stringify(value)}`
			);
		}
	}
}

/** Check that `value` matches the expected JSON Schema primitive type. */
function checkType(value: unknown, type: JsonSchemaProperty["type"]): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
		case "integer":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return (
				typeof value === "object" && value !== null && !Array.isArray(value)
			);
		default:
			return false;
	}
}

// ── ToolRunnable ──────────────────────────────────────────────────────────────

/**
 * A `Runnable` with an extra `schema` field exposing the tool's JSON Schema.
 *
 * The `schema` is compatible with Core's `ToolInfo.schema` shape so it can
 * be forwarded verbatim to Core's MCP/ACP layer.
 */
export interface ToolRunnable<
	TInput extends Record<string, unknown> = Record<string, unknown>,
	TOutput = unknown,
> extends Runnable<TInput, TOutput> {
	readonly kind: "tool";
	/** JSON Schema for this tool's input — compatible with Core's ToolInfo.schema. */
	readonly schema: ToolSchema;
	/**
	 * The `run` body serialized for Core's `inline_deno` tool backend — the exact
	 * same technique `defineTurnHook` uses for its `code`. This is what makes a
	 * `defineTool` **shippable**: bundled into a plugin manifest (see
	 * {@link inlineToolRunnable} / `definePlugin({ tools })`), Core runs it in the
	 * Deno sandbox, so the tool ships NEW behavior instead of only aliasing an
	 * existing tool.
	 *
	 * IMPORTANT: like a hook body, the serialized function is **self-contained** —
	 * it runs in a fresh sandbox with only `input` (the call arguments) and `host`
	 * (the capability bridge: `host.sideModel` / `host.storage` / `host.log`, each
	 * gated by the plugin's grants) in scope. It cannot capture outer variables,
	 * imports, or closures, and `ctx.gateway` is **not** available in the sandbox
	 * — a shipped tool reaches models through `host.sideModel`. When run in-process
	 * via {@link ToolRunnable.run} the normal `(input, ctx)` contract still holds;
	 * the sandbox form is the second parameter aliased to `host`.
	 */
	readonly code: string;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a Runnable tool with input validation.
 *
 * The returned value satisfies `ToolRunnable<TInput, TOutput>` (which extends
 * `Runnable`) with `kind = "tool"`.  The `schema` property is the JSON Schema
 * descriptor passed in options — forwarding it to Core's `ToolInfo.schema`
 * requires no transformation.
 *
 * Input is validated at `run()` time: missing required fields or type
 * mismatches throw before the tool body executes.
 *
 * @example
 * ```ts
 * const searchTool = defineTool({
 *   id: "tool-web-search",
 *   name: "Web Search",
 *   schema: {
 *     type: "object",
 *     properties: { query: { type: "string", description: "Search query" } },
 *     required: ["query"],
 *   },
 *   async run({ query }, _ctx) {
 *     return { results: [`Result for: ${query}`] };
 *   },
 * });
 * // schema is Core-compatible:
 * console.log(searchTool.schema); // { type: "object", properties: { query: ... }, required: [...] }
 * ```
 */
export function defineTool<
	TInput extends Record<string, unknown> = Record<string, unknown>,
	TOutput = unknown,
>(options: ToolOptions<TInput, TOutput>): ToolRunnable<TInput, TOutput> {
	const { id, name, schema, run } = options;

	// Serialize the run body for Core's `inline_deno` backend — the same approach
	// `defineTurnHook` uses: the sandbox wraps this in an async IIFE where `input`
	// and `host` are in scope and a bare `return` reports the tool result.
	const code = `return await (${run.toString()})(input, host);`;

	return {
		id,
		name,
		kind: "tool",
		schema,
		code,
		run(input: TInput, ctx: RunnableContext): Promise<TOutput> {
			validateInput(input, schema, id);
			return run(input, ctx);
		},
	} satisfies ToolRunnable<TInput, TOutput>;
}

/**
 * Convert a {@link ToolRunnable} into a `manifest.json` `kind:"tool"` runnable that
 * ships its `run` body as Core's `inline_deno` backend. The emitted config
 * mirrors Core's `ToolConfig` (`apps/core/src/plugin_manifest/schema.rs`):
 * `{ slug, backend:"inline_deno", code, description?, input_schema }`. Core
 * registers it as `app__<slug>` — discoverable via `/api/tools/search` and
 * executed in the grant-gated sandbox.
 *
 * The plugin must declare the `tool:execute` grant (see `definePlugin`).
 */
export function inlineToolRunnable(
	tool: ToolRunnable,
	options?: { description?: string }
): RunnableMeta {
	return {
		id: tool.id,
		name: tool.name,
		kind: "tool",
		config: {
			slug: tool.id,
			backend: "inline_deno",
			code: tool.code,
			input_schema: tool.schema,
			...(options?.description ? { description: options.description } : {}),
		},
	};
}
