import { z } from "zod";

const invalidSession = "Invalid Better Auth session response";

// Historical clients observe only an object-valued profile. This is not a full
// Better Auth user: partial/empty objects and arbitrary metadata are retained.
const legacyProfileFields = z.looseObject(
	{
		name: z.unknown().optional(),
		email: z.unknown().optional(),
	},
	{ error: invalidSession }
);
export const legacyRawAuthProfileObservationSchema = z.custom<
	z.output<typeof legacyProfileFields>
>((value) => legacyProfileFields.safeParse(value).success, {
	error: invalidSession,
});
export type LegacyRawAuthProfileObservation = z.output<
	typeof legacyRawAuthProfileObservationSchema
>;
