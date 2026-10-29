import { z } from "zod";

// The published BetterAuth device-authorization route returns these complete
// six fields. Fixed field diagnostics keep fallback parsing independent of
// ambient application error formatting.
const deviceText = z.string({ error: "Invalid device response string" });
const deviceSeconds = z.number({ error: "Invalid device response seconds" });
export const deviceCodeResponseSchema = z.looseObject(
	{
		device_code: deviceText.min(1, { error: "Invalid device response code" }),
		user_code: deviceText.min(1, { error: "Invalid device response code" }),
		verification_uri: deviceText,
		verification_uri_complete: deviceText,
		expires_in: deviceSeconds,
		interval: deviceSeconds,
	},
	{ error: "Invalid device code response object" }
);

// This is the existing client's explicit legacy projection, not a promise of
// the full current publisher above: missing or malformed optional hints retain
// the client's browser/timing defaults after the required two codes are read.
export const deviceCodeClientProjectionSchema = deviceCodeResponseSchema.extend(
	{
		verification_uri: deviceText.optional().catch(undefined),
		verification_uri_complete: deviceText.optional().catch(undefined),
		expires_in: deviceSeconds.optional().catch(undefined),
		interval: deviceSeconds.optional().catch(undefined),
	}
);

// BetterAuth publishes all four fields on a successful token response.
export const deviceTokenResponseSchema = z.looseObject(
	{
		access_token: deviceText.min(1, { error: "Invalid device response code" }),
		token_type: z.literal("Bearer", { error: "Invalid device token type" }),
		expires_in: deviceSeconds,
		scope: deviceText,
	},
	{ error: "Invalid device token response object" }
);

// Legacy clients consumed a nonempty token without requiring the other three
// published metadata fields. Preserve that admission without calling it the
// complete current token response. Raw error replies remain outside this parse.
export const deviceTokenClientProjectionSchema =
	deviceTokenResponseSchema.extend({
		token_type: z
			.literal("Bearer", { error: "Invalid device token type" })
			.optional()
			.catch(undefined),
		expires_in: deviceSeconds.optional().catch(undefined),
		scope: deviceText.optional().catch(undefined),
	});
