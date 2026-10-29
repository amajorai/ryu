import { z } from "zod";

const settingNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const storedServiceConfigSchema = z
	.object({
		coreBaseUrl: z.string().optional().catch(undefined),
		// Legacy: older builds wrote the token here in plaintext (migrated on load).
		coreToken: z.string().nullable().optional().catch(undefined),
		// `safeStorage`-sealed explicit token, base64.
		coreTokenSealed: z.string().optional().catch(undefined),
		engine: z
			.object({
				pollIntervalSeconds: settingNumberSchema.optional().catch(undefined),
				cooldownSeconds: settingNumberSchema.optional().catch(undefined),
			})
			.optional()
			.catch(undefined),
	})
	.catch(() => ({}));

/** Read only the user-configurable Core and engine fields from persisted JSON. */
export function parseStoredServiceConfig(raw: string) {
	try {
		return storedServiceConfigSchema.parse(JSON.parse(raw));
	} catch {
		return storedServiceConfigSchema.parse({});
	}
}
