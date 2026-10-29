import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";

const coreStateFieldsSchema = z.object({
	port: z.number(),
	dataDir: z.string(),
});
type CoreState = z.infer<typeof coreStateFieldsSchema>;
export const coreProofStateSchema = z.custom<CoreState>((value) => {
	const parsed = pluginDocumentSchema.safeParse(value);
	return parsed.success && coreStateFieldsSchema.safeParse(parsed.data).success;
});

// This proof counts the live roster, then forwards the original response to the
// production picker. Its boundary validates JSON rows without narrowing them.
export const coreProofRosterSchema = z.object({
	agents: z.array(pluginValueSchema),
});
