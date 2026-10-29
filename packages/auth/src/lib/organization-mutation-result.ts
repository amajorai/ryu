import { isAPIError } from "@better-auth/core/utils/is-api-error";
import type { APIError } from "better-auth/api";
import { z } from "zod";

/** Better Auth invokes after-hooks for rejected endpoints as well as successes. */
const rejectedMutationSchema = z.union([
	z.custom<APIError>(isAPIError),
	z.instanceof(Response).refine((response) => !response.ok),
]);
export const organizationMutationSucceeded = z
	.unknown()
	.transform(
		(returned) => !rejectedMutationSchema.safeParse(returned).success
	).parse;
