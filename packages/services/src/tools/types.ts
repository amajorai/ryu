// packages/services/src/tools/types.ts
//
// The shape of one service tool in the @ryuhq/services tool registry. Every
// surface that exposes the services as tools reads the same definitions: the
// `ryu-services mcp` server, `toAiSdkTools` (Vercel AI SDK) and
// `toRyuAgentTools` (@ryuhq/sdk Agent). A definition is plain data plus a
// `run(ryu, input, context)` body, so it carries no framework dependency.

import type * as z from "zod";
import type { RyuService } from "../errors.ts";
import type { Ryu } from "../ryu.ts";
import type { RyuToolOutputSchema } from "./output.ts";

/**
 * What calling a tool does, in MCP's annotation vocabulary. All four are
 * required so every tool states its effects.
 */
export interface RyuToolAnnotations {
	/** It can destroy or overwrite something (a Box, a file, what a Site serves). */
	readonly destructiveHint: boolean;
	/** Repeating the same call has no further effect. */
	readonly idempotentHint: boolean;
	/** It reaches people or systems outside Ryu (sends email or SMS, runs a model, fetches a site). */
	readonly openWorldHint: boolean;
	/** It changes nothing. The adapters expose only these tools unless writes are enabled. */
	readonly readOnlyHint: boolean;
}

/** What a tool body gets besides its input. */
export interface RyuToolContext {
	/** Fires when the host cancels the call. */
	readonly signal?: AbortSignal;
}

/** One service tool. */
export interface RyuToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
	readonly annotations: RyuToolAnnotations;
	/**
	 * `true` when the tool's route needs no credential (`mail_status`,
	 * `messaging_status`). `ryu-services mcp` registers such a tool for a
	 * service that is not configured when `ryu.canCallWithoutCredentials`
	 * says its URL resolves; the call then sends no key. Only read-only
	 * tools may set it. The adapters (`selectRyuTools`) still expose a tool
	 * only for configured services.
	 */
	readonly credentialFree?: boolean;
	/** What the tool does, written for a model choosing between tools. */
	readonly description: string;
	/** The tool's arguments. Input is parsed with it before `run`. */
	readonly inputSchema: Schema;
	/** `<service prefix>_<verb>` in snake_case, e.g. `notify_publish`. Stable across releases. */
	readonly name: string;
	/**
	 * What a successful call answers: `{ data, meta }` with `data` typed per
	 * tool (build it with `toolOutput(dataSchema)`). `ryu-services mcp`
	 * declares it as the tool's MCP `outputSchema`, so `data` must describe
	 * every value `run` can resolve to, after the JSON round trip.
	 */
	readonly outputSchema: RyuToolOutputSchema;
	/**
	 * The tool body. Return the facade promise itself
	 * (`(ryu, input) => ryu.notify.publish(input)`), or `settled(call)` from
	 * an async body, so the result carries the call's meta.
	 */
	run(ryu: Ryu, input: z.output<Schema>, context: RyuToolContext): unknown;
	/** The service the tool calls. */
	readonly service: RyuService;
	/** A short human title, e.g. "Publish a Notify event". */
	readonly title: string;
}

/**
 * Any registry tool, whatever its input schema. `run` is declared as a
 * method, so a definition with a narrower schema is assignable to this.
 */
export type AnyRyuTool = RyuToolDefinition<z.ZodObject>;

/**
 * Declares a registry tool with its `run` input typed from `inputSchema`.
 * An identity function: it exists for inference only.
 */
export function defineRyuTool<Schema extends z.ZodObject>(
	definition: RyuToolDefinition<Schema>
): RyuToolDefinition<Schema> {
	return definition;
}
