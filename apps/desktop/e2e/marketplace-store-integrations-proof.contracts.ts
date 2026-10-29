import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import { connectionAccessLevelSchema } from "../src/lib/connection-permissions.ts";

/** Native HTTP JSON carrier: raw references and future metadata are retained. */
export const integrationsProofJsonSchema = appResponseValueSchema;
export type IntegrationsProofJson = z.output<
	typeof integrationsProofJsonSchema
>;
function preserveIntegrationsRequest<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			integrationsProofJsonSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Complete emitted request bodies from initiateComposioConnection/connectMcpOAuth.
export const integrationsComposioConnectSchema = preserveIntegrationsRequest(
	z.looseObject({
		access_level: connectionAccessLevelSchema,
		toolkit: z.string(),
	})
);
export const integrationsMcpConnectSchema = preserveIntegrationsRequest(
	z.looseObject({
		access_level: connectionAccessLevelSchema,
		callback_mode: z.literal("auto"),
		profile_id: z.string(),
	})
);
