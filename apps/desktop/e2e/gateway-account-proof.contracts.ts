import { z } from "zod";
import type {
	CloudSpeechEdit,
	CloudSpeechPolicy,
} from "../src/lib/api/cloud-speech-accounts.ts";
import type { GatewayConfigPatch } from "../src/lib/api/gateway.ts";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

/** Validate the publisher's raw edit domain and retain the whole native JSON
 * value; assertions must continue observing unexpected fields and references. */
function nativeGatewayInput<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			schema.safeParse(value).success
	);
}
const accountRoutingFieldsSchema = z.object({
	providerAccountStrategies: z
		.record(
			z.string(),
			z.enum(["round_robin", "quota_first", "fill_first", "reset_first"])
		)
		.optional(),
	providerAccountDrainThresholds: z.record(z.string(), z.number()).optional(),
}) satisfies z.ZodType<
	Pick<
		GatewayConfigPatch,
		"providerAccountStrategies" | "providerAccountDrainThresholds"
	>
>;
export const accountRoutingInputSchema = nativeGatewayInput(
	accountRoutingFieldsSchema
);
const cloudPolicySchema = nativeGatewayInput(
	z.object({
		name: z.string(),
		enabled: z.boolean(),
		priority: z.number(),
	}) satisfies z.ZodType<CloudSpeechPolicy>
);
const cloudEditFieldsSchema = z.union([
	z.object({
		action: z.literal("configure"),
		provider: z.enum(["google-tts", "polly"]),
		accountId: z.string(),
		accountPolicy: cloudPolicySchema,
	}),
	z.object({
		action: z.literal("add"),
		provider: z.literal("google-tts"),
		accessToken: z.string(),
		quotaProject: z.string(),
		expiresAtUnixSecs: z.number().optional(),
	}),
	z.object({
		action: z.literal("add"),
		provider: z.literal("polly"),
		region: z.string(),
		accessKeyId: z.string(),
		secretAccessKey: z.string(),
		sessionToken: z.string().optional(),
		expiresAtUnixSecs: z.number().optional(),
	}),
	z.object({
		action: z.literal("remove"),
		provider: z.enum(["google-tts", "polly"]),
		accountId: z.string(),
	}),
]) satisfies z.ZodType<CloudSpeechEdit>;
export const cloudSpeechInputSchema = nativeGatewayInput(
	z.intersection(
		cloudEditFieldsSchema,
		z.object({ expectedRevision: z.string() })
	)
);
const clientKeySchema = nativeGatewayInput(
	z.object({
		key: z.string(),
		name: z.string(),
		trusted_forwarder: z.boolean(),
		allowed_operations: z.array(z.string()).optional(),
	})
);
export const clientKeyInputSchema = nativeGatewayInput(
	z.object({
		auth: nativeGatewayInput(z.object({ api_keys: z.array(clientKeySchema) })),
	})
);
