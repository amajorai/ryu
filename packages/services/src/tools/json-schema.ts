// packages/services/src/tools/json-schema.ts
//
// A registry tool's input schema as JSON Schema, for hosts that take JSON
// Schema rather than zod (the @ryuhq/sdk Agent, OpenAI-style function
// definitions). Converted with zod's own `z.toJSONSchema` in input mode, so
// defaults and optional fields read as the caller sends them.

import * as z from "zod";
import type { AnyRyuTool } from "./types.ts";

/** A JSON value. */
export type RyuJsonValue =
	| string
	| number
	| boolean
	| null
	| RyuJsonValue[]
	| { [key: string]: RyuJsonValue };

/**
 * One property of a tool's argument schema, typed as the subset the
 * @ryuhq/sdk tool schema (and OpenAI function calling) names. The value is
 * whatever JSON Schema zod produced, so a property may also carry other
 * keywords (`anyOf`, `format`, `minimum`, …).
 */
export interface RyuToolJsonSchemaProperty {
	description?: string;
	enum?: RyuJsonValue[];
	items?: RyuToolJsonSchemaProperty;
	properties?: Record<string, RyuToolJsonSchemaProperty>;
	required?: string[];
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
}

/** A tool's argument schema: a JSON Schema object whose root is `type: "object"`. */
export interface RyuToolJsonSchema {
	properties: Record<string, RyuToolJsonSchemaProperty>;
	required?: string[];
	type: "object";
	[key: string]:
		| RyuJsonValue
		| Record<string, RyuToolJsonSchemaProperty>
		| undefined;
}

/** The JSON Schema of `tool`'s arguments. */
export function ryuToolJsonSchema(tool: AnyRyuTool): RyuToolJsonSchema {
	const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.inputSchema, {
		io: "input",
		unrepresentable: "any",
	});
	// SAFETY: zod emits JSON values only, and an object schema's root carries
	// `type: "object"` and `properties` (each a property schema; see
	// RyuToolJsonSchemaProperty for the subset that is typed).
	return {
		...(schema as Record<string, RyuJsonValue>),
		type: "object",
		properties: (schema.properties ?? {}) as Record<
			string,
			RyuToolJsonSchemaProperty
		>,
	};
}
