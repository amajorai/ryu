import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

function nativeResponse<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Complete actual Core auth handlers. Optional omissions retain legacy replies.
export const loginStartResponseSchema = nativeResponse(
	z.object({
		error: z.string().optional(),
		userCode: z.string().nullish(),
		verificationUri: z.string().nullish(),
		verificationUriComplete: z.string().nullish(),
	})
);
const accountFields = z.object({
	active: z.boolean(),
	email: z.string(),
	image: z.string().nullish(),
	name: z.string().nullish(),
	userId: z.string(),
});
export const accountsResponseSchema = nativeResponse(
	z.object({
		accounts: z.array(accountFields).optional(),
		activeUserId: z.string().nullish(),
	})
);
export const accountMutationResponseSchema = nativeResponse(
	z.object({
		success: z.boolean().optional(),
		error: z.string().optional(),
		activeUserId: z.string().nullish(),
	})
);
// Complete Hono token-free session-list6 publisher.
const listedSessionFields = z.object({
	createdAt: z.string(),
	expiresAt: z.string(),
	id: z.string(),
	ipAddress: z.string().optional(),
	userAgent: z.string().optional(),
	userId: z.string(),
});
export const sessionsResponseSchema = nativeResponse(
	z.object({ sessions: z.array(listedSessionFields).optional() })
);
export type LoginStart = z.output<typeof loginStartResponseSchema>;
export type Account = z.output<typeof accountFields>;
