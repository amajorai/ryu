import { z } from "zod";

// This is the historical token-only credential observation, not a complete
// BetterAuth session/user DTO. Metadata is deliberately opaque: JSON.parse
// exponent overflow, deep trees and own __proto__ fields are not newly rejected.
const tokenObservation = z.looseObject(
	{
		token: z.string({ error: "Invalid stored credential token" }).min(1, {
			error: "Invalid stored credential token",
		}),
		backendUrl: z.unknown().optional(),
		email: z.unknown().optional(),
		name: z.unknown().optional(),
	},
	{ error: "Invalid stored credential object" }
);

export const storedCredentialTokenObservationSchema = z.custom<
	z.output<typeof tokenObservation>
>((value) => tokenObservation.safeParse(value).success, {
	error: "Invalid stored credential",
});
export type StoredCredentialTokenObservation = z.output<
	typeof storedCredentialTokenObservationSchema
>;
