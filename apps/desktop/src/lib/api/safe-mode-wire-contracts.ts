import { z } from "zod";
/** Core's complete safe-mode projection; nullish legacy fields are normalized
 * by the client. Future source strings retain the established off fallback. */
export const safeModeSourceSchema = z.enum([
	"off",
	"env",
	"sentinel",
	"preference",
]);
export const safeModeWireSchema = z
	.object({
		enabled: z.boolean().nullish(),
		preference_enabled: z.boolean().nullish(),
		source: z.string().nullish(),
		suppressed: z
			.object({
				kernel_plugins: z.number().nullish(),
				mcp_servers: z.number().nullish(),
				plugins: z.number().nullish(),
				skills: z.number().nullish(),
			})
			.nullish(),
		user_clearable: z.boolean().nullish(),
	})
	.nullish();
export type RawSafeModeState = z.output<typeof safeModeWireSchema>;
export type RawSafeModeInput = Parameters<typeof safeModeWireSchema.parse>[0];
/** The native get_safe_mode_sentinel command returns exactly a boolean. */
export const safeModeSentinelSchema = z.boolean();
export type SafeModeSentinelInput = Parameters<
	typeof safeModeSentinelSchema.parse
>[0];
