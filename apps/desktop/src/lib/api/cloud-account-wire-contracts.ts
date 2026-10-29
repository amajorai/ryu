import { z } from "zod";
import { pluginDocumentSchema } from "./plugin-wire-values.ts";
/** Core's GitHub response is a public projection, excluding the submitted token. */
export const cloudGithubRepositorySchema = z.object({
	fullName: z
		.string()
		.max(256)
		.regex(/^[\w.-]+\/[\w.-]+$/),
	private: z.boolean(),
});
// Validate the container first to preserve its distinct error precedence. Each
// repository is decoded before any full connection is returned to a caller.
export const cloudGithubEnvelopeSchema = z.object({
	connected: z.boolean(),
	login: z.string().nullable(),
	vaultKey: z.string().nullable(),
	repositories: z.array(z.unknown()).max(100),
});
export const cloudGithubStateProjectionSchema = z
	.object({ state: z.unknown().optional() })
	.transform((value) => ({ present: "state" in value, state: value.state }));
export type CloudGithubInput = Parameters<
	typeof cloudGithubEnvelopeSchema.parse
>[0];
/** Full redacted account DTOs from gateway_cloud_speech_accounts.rs::view. */
function cloudAccountRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const accountIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const cloudSpeechPolicySchema = cloudAccountRecord(
	z.object({
		enabled: z.boolean(),
		name: z.string(),
		priority: z.number().int().min(0).max(65_535),
	})
);
const googleSpeechAccountSchema = cloudAccountRecord(
	z.object({
		accountId: accountIdSchema,
		quotaProject: z.string(),
		expiresAtUnixSecs: z.number().nullable(),
		policy: cloudSpeechPolicySchema,
	})
);
const pollySpeechAccountSchema = cloudAccountRecord(
	z.object({
		accountId: accountIdSchema,
		accessKeyHint: z.string(),
		hasSessionToken: z.boolean(),
		expiresAtUnixSecs: z.number().nullable(),
		policy: cloudSpeechPolicySchema,
	})
);
export const cloudSpeechAccountsSchema = cloudAccountRecord(
	z.object({
		cloudSpeechAccountsSchema: z.literal(1),
		configRevision: accountIdSchema,
		googleTts: z.array(googleSpeechAccountSchema),
		polly: cloudAccountRecord(
			z.object({
				region: z.string(),
				accounts: z.array(pollySpeechAccountSchema),
			})
		),
	})
);
export type CloudSpeechAccountsInput = Parameters<
	typeof cloudSpeechAccountsSchema.parse
>[0];
