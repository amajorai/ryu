// packages/services/src/tools/output.ts
//
// What a registry tool answers on success, as a zod schema: the MCP
// `outputSchema` that `ryu-services mcp` declares for each tool, exported to
// the Python port's manifest as JSON Schema. A successful call's
// `structuredContent` is `{ data, meta }`; a tool error is `isError: true`
// with `{ error }`, which MCP does not validate against `outputSchema`.
//
// `data` is typed per tool from the reply the SDK already validated: the
// response contracts in packages/client (`*-contracts.ts`, whose exported
// schemas are opaque `z.custom` checks) and the decoders in this package
// (sites, gateway, passport). Each data schema states the fields those
// contracts guarantee and leaves the rest open (`z.looseObject`, JSON Schema
// `additionalProperties: {}`), because the services add fields over time and
// the SDK keeps them. A data schema must never be stricter than the SDK's own
// reply validation, or a reply the SDK accepted would fail the tool.
// `output.test.ts` runs every tool body against recorded or contract-shaped
// replies and validates the result.

import * as z from "zod";
import type { RyuJsonValue } from "./json-schema.ts";
import type { AnyRyuTool } from "./types.ts";

/**
 * A success result's `meta`. `ryu-services mcp` returns the call's full
 * response meta (attempts, status, rate limit, deprecation, request id,
 * idempotency key, replayed); the AI SDK, @ryuhq/sdk and Python adapters
 * return the compact form with only the request id, idempotency key and
 * replay, each only when set. Every field is optional so both conform.
 */
export const toolMetaSchema = z
	.looseObject({
		attempts: z.number().optional(),
		deprecation: z.looseObject({}).nullable().optional(),
		idempotencyKey: z.string().nullable().optional(),
		rateLimit: z.looseObject({}).nullable().optional(),
		replayed: z.boolean().optional(),
		requestId: z.string().nullable().optional(),
		status: z.number().optional(),
	})
	.describe(
		"The call's response meta: request id, idempotency key and whether the server replayed an earlier result."
	);

/** A tool's success output: `{ data, meta }` with `data` typed per tool. */
export type RyuToolOutputSchema<Data extends z.ZodType = z.ZodType> =
	z.ZodObject<{ data: Data; meta: typeof toolMetaSchema }>;

/** The `{ data, meta }` output schema of a tool whose result data is `data`. */
export function toolOutput<Data extends z.ZodType>(
	data: Data
): RyuToolOutputSchema<Data> {
	return z.object({ data, meta: toolMetaSchema });
}

/** A tool that answers with no data (the call returned nothing): `data` is null. */
export const NO_DATA = toolOutput(
	z.null().describe("Nothing: the call succeeded and returned no body.")
);

// Field types the data schemas share.

/** A string or null. */
export const nullableText = z.string().nullable();
/** A JSON object the service defines (metadata, tool input, config). */
export const openObject = z.looseObject({});
/** A string-to-string map (metadata, headers). */
export const stringMap = z.record(z.string(), z.string());

/** A JSON Schema document. */
export interface RyuToolOutputJsonSchema {
	[key: string]: RyuJsonValue;
}

/**
 * The JSON Schema of `tool`'s success output (`{ data, meta }`), as MCP
 * `tools/list` advertises it. Converted with zod's `z.toJSONSchema` in output
 * mode, without the `$schema` dialect key. Its root allows only `data` and
 * `meta`: to check a `toToolResultJson` result, which also carries
 * `error: null` on success, validate `{ data, meta }` from it.
 */
export function ryuToolOutputJsonSchema(
	tool: Pick<AnyRyuTool, "outputSchema">
): RyuToolOutputJsonSchema {
	const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.outputSchema, {
		io: "output",
		unrepresentable: "any",
	});
	// SAFETY: zod emits JSON values only.
	return schema as RyuToolOutputJsonSchema;
}
