import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

/** Successful HTTP JSON only. Validate all declared publisher fields while
 * returning the original full transport object and future metadata references. */
function nativeResponse<
	S extends
		| z.ZodObject
		| z.ZodNullable<z.ZodObject>
		| z.ZodUnion<readonly z.ZodObject[]>,
>(schema: S) {
	return z.custom<z.output<S>>(
		(input) =>
			appJsonValueSchema.safeParse(input).success &&
			schema.safeParse(input).success
	);
}
// Native Date JSON serialization emits an ISO string or null for an invalid Date.
const nativeDate = z.string().nullable();
const optionalString = z.string().nullable().optional();
const optionalDate = nativeDate.nullable().optional();
const authUserResponseSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	emailVerified: z.boolean(),
	createdAt: nativeDate,
	updatedAt: nativeDate,
	image: optionalString,
	twoFactorEnabled: z.boolean().nullable().optional(),
	avatarId: optionalString,
	resendContactId: optionalString,
	emailVerifiedAt: optionalDate,
	lastEmailSentAt: optionalDate,
	dailyEmailCount: z.number().nullable().optional(),
	lastEmailResetDate: optionalDate,
	referralCode: optionalString,
	referredBy: optionalString,
	referralCount: z.number().nullable().optional(),
	profileVisibility: optionalString,
	username: optionalString,
	displayUsername: optionalString,
	isAnonymous: z.boolean().nullable().optional(),
	role: optionalString,
	banned: z.boolean().nullable().optional(),
	banReason: optionalString,
	banExpires: optionalDate,
});
const authSessionRecordSchema = z.looseObject({
	id: z.string(),
	userId: z.string(),
	token: z.string(),
	expiresAt: nativeDate,
	createdAt: nativeDate,
	updatedAt: nativeDate,
	ipAddress: optionalString,
	userAgent: optionalString,
	impersonatedBy: optionalString,
	activeOrganizationId: optionalString,
	activeTeamId: optionalString,
});
export const securitySessionResponseSchema = nativeResponse(
	z
		.looseObject({
			session: authSessionRecordSchema,
			user: authUserResponseSchema,
			needsRefresh: z.boolean().optional(),
		})
		.nullable()
);
export type SecuritySessionResponse = z.output<
	typeof securitySessionResponseSchema
>;

const scope = z.enum([
	"account.merge",
	"account.security",
	"org.credentials",
	"org.delete",
	"org.features",
	"org.members",
	"org.security",
	"node.destroy",
	"billing",
	"platform.admin",
]);
const method = z.enum(["totp", "otp", "backup", "password", "magic-link"]);
export const securityStepUpStatusResponseSchema = nativeResponse(
	z.looseObject({
		action: z.string(),
		enrolmentRequired: z.boolean(),
		methods: z.array(method),
		passwordAvailable: z.boolean(),
		satisfied: z.boolean(),
		scope,
		twoFactorEnabled: z.boolean(),
		windowMs: z.number(),
	})
);
export const securityStepUpVerifyResponseSchema = nativeResponse(
	z.looseObject({
		expiresAt: nativeDate,
		scope,
		verified: z.literal(true),
	})
);
export const securityStepUpChallengeResponseSchema = nativeResponse(
	z.union([
		z.looseObject({ sent: z.literal(true) }),
		z.looseObject({ sent: z.literal(false), skipped: z.literal(true) }),
	])
);
export const securityVerifyTotpResponseSchema = nativeResponse(
	z.looseObject({
		token: z.string(),
		user: authUserResponseSchema,
		// The installed native success does not publish backupCodes. Preserve the
		// historical optional observation without promoting it to a required field.
		backupCodes: z.array(z.string()).nullable().optional(),
	})
);
export const securityEnableTwoFactorResponseSchema = nativeResponse(
	z.discriminatedUnion("method", [
		z.looseObject({ method: z.literal("otp") }),
		z.looseObject({
			method: z.literal("totp"),
			totpURI: z.string(),
			backupCodes: z.array(z.string()),
		}),
	])
);
export const securityBackupCodesResponseSchema = nativeResponse(
	z.looseObject({
		status: z.literal(true),
		backupCodes: z.array(z.string()),
	})
);
export const securityPasswordStatusResponseSchema = nativeResponse(
	z.looseObject({
		hasPassword: z.boolean(),
		provider: z.string().nullable(),
		authMethod: z.string(),
	})
);
export const securitySetPasswordResponseSchema = nativeResponse(
	z.looseObject({
		success: z.literal(true),
		action: z.enum(["changed", "set"]),
		message: z.string(),
	})
);
export const securityEmailChangeStatusResponseSchema = nativeResponse(
	z.discriminatedUnion("hasActive", [
		z.looseObject({ hasActive: z.literal(false), message: z.string() }),
		z.looseObject({
			hasActive: z.literal(true),
			emailChange: z.looseObject({
				id: z.string(),
				newEmail: z.string(),
				oldEmail: z.string(),
				status: z.enum([
					"pending",
					"old_confirmed",
					"new_confirmed",
					"verified",
					"cancelled",
					"expired",
				]),
				statusMessage: z.string(),
				createdAt: nativeDate,
				expiresAt: nativeDate,
				oldEmailConfirmedAt: optionalDate,
				newEmailConfirmedAt: optionalDate,
			}),
		}),
	])
);
export const securityMessageSuccessResponseSchema = nativeResponse(
	z.looseObject({
		success: z.literal(true),
		message: z.string(),
	})
);
export const accountSwitchResponseSchema = nativeResponse(
	z.discriminatedUnion("success", [
		z.looseObject({ success: z.literal(true) }),
		z.looseObject({ success: z.literal(false), error: z.string() }),
	])
);

export type SecurityEmailChangeResponse = z.output<
	typeof securityEmailChangeStatusResponseSchema
>;
