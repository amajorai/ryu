import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

function preserveNavigation<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			schema.safeParse(value).success
	);
}
/** Full native publisher, including opaque Option<serde_json::Value> params. */
export const navigationPublisherSchema = preserveNavigation(
	z
		.looseObject({
			plugin_id: z.string(),
			target: z.string(),
			params: appJsonValueSchema.optional(),
			kind: z.enum(["tab", "panel", "browser", "interface"]).optional(),
			force_new: z.boolean().optional(),
			target_user_id: z.string().optional(),
		})
		.catchall(appJsonValueSchema)
);
/** Existing consumer permits legacy missing plugin identity; future kind strings
 * retain the existing tab fallback. Known identity fields still admit only native
 * strings; optional serde JSON params preserve null/arrays/primitives unchanged. */
export const navigationLegacySchema = preserveNavigation(
	z
		.looseObject({
			plugin_id: z.string().nullish(),
			target: z.string(),
			params: appJsonValueSchema.optional(),
			kind: z.string().nullish(),
			force_new: z.boolean().nullish(),
			target_user_id: z.string().nullish(),
		})
		.catchall(appJsonValueSchema)
);
export type NavigationLegacyRequest = z.output<typeof navigationLegacySchema>;
