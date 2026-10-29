import { z } from "zod";
import {
	type PluginValue,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import type { AgentAutoRoutingConfig } from "../src/lib/api/preferences.ts";

// This is the complete persisted publisher value, rather than the tolerant
// preferences reader's fallback output. Unexpected native fields remain visible.
const autoRoutingFields = z.object({
	cache_by_session: z.boolean(),
	classifier_model: z.string(),
	default_agent_id: z.string(),
	embedding_model: z.string(),
	enabled: z.boolean(),
	rules: z.array(z.object({ agent_id: z.string(), description: z.string() })),
	similarity_threshold: z.number(),
	strategy: z.enum(["embedding", "keyword", "llm"]),
}) satisfies z.ZodType<AgentAutoRoutingConfig>;
const autoRoutingSchema = z.custom<AgentAutoRoutingConfig>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		autoRoutingFields.safeParse(value).success
);
const preferenceWriteFields = z.object({ value: z.string() });

export function decodeAutoRoutingConfig(raw: string): AgentAutoRoutingConfig {
	return autoRoutingSchema.parse(JSON.parse(raw));
}
export function decodeAutoRoutingWrite(
	body: PluginValue | undefined
): AgentAutoRoutingConfig {
	const envelope = preferenceWriteFields.parse(body);
	return decodeAutoRoutingConfig(envelope.value);
}
