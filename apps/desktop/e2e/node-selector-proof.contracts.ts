import { z } from "zod";
import {
	type PluginValue,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import type { Node } from "../src/store/useNodeStore.ts";

const nodeFields = z.object({
	managed: z.boolean().optional(),
	name: z.string(),
	orgId: z.string().nullable().optional(),
	serverId: z.string().nullable().optional(),
	token: z.string().nullable(),
	url: z.string(),
	userJwt: z.string().nullable().optional(),
}) satisfies z.ZodType<Node>;
const nodesSchema = z.array(
	z.custom<Node>((value) => nodeFields.safeParse(value).success)
);
const booleanFields = z.record(z.string(), z.boolean());
const booleansSchema = z.custom<z.output<typeof booleanFields>>(
	(value) => booleanFields.safeParse(value).success
);
const numberFields = z.record(z.string(), z.number());
const numbersSchema = z.custom<z.output<typeof numberFields>>(
	(value) => numberFields.safeParse(value).success
);
const sidecarFields = z.record(
	z.string(),
	z.object({ running: z.boolean(), version: z.string() })
);
const sidecarsSchema = z.custom<z.output<typeof sidecarFields>>(
	(value) => sidecarFields.safeParse(value).success
);
const sandboxFields = z.object({
	elapsed_seconds: z.number().optional(),
	org_id: z.string().nullable().optional(),
	run_id: z.string().optional(),
	spec: z
		.object({
			gpu: z.string().nullable().optional(),
			mem_gib: z.number().nullable().optional(),
			os: z.string().nullable().optional(),
			vcpu: z.number().nullable().optional(),
		})
		.nullable()
		.optional(),
});
const sandboxSchema = z.custom<z.output<typeof sandboxFields>>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		sandboxFields.safeParse(value).success
);
const discoveredFields = z.object({
	latency_ms: z.number(),
	profile: z.string().optional(),
	url: z.string(),
});
const discoveredSchema = z.array(
	z.custom<z.output<typeof discoveredFields>>(
		(value) => discoveredFields.safeParse(value).success
	)
);

export type NodeSelectorNativeArgs = Record<string, PluginValue | undefined>;

export const readProofNodes = (raw: string) =>
	nodesSchema.parse(JSON.parse(raw));
export const readProofBooleans = (raw: string) =>
	booleansSchema.parse(JSON.parse(raw));
export const readProofNumbers = (raw: string) =>
	numbersSchema.parse(JSON.parse(raw));
export const readProofSidecars = (raw: string) =>
	sidecarsSchema.parse(JSON.parse(raw));
export const readProofSandboxes = (raw: string) =>
	z.array(sandboxSchema).parse(JSON.parse(raw));
export const readProofDiscoveredNodes = (raw: string) =>
	discoveredSchema.parse(JSON.parse(raw));
