import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

// The most recently settled device flow, keyed by the `userCode` that
// `/api/auth/login` returned. A failed "add account" flow leaves Core
// `authenticated` with the previous account, so only this tells the client that
// started the flow whether it added an account.
const coreDeviceFlowOutcomeSchema = z.object({
	userCode: z.string(),
	result: z.enum(["succeeded", "failed"]),
	error: z.string().nullable(),
});
export type CoreDeviceFlowOutcome = z.output<
	typeof coreDeviceFlowOutcomeSchema
>;

// Core's /api/auth/status publisher (apps/core/src/server/mod.rs auth_status)
// serializes all five fields; trusted-peer filtering publishes a null token.
// `lastFlow` is absent from a Core that predates it.
const coreAuthStatusFields = z
	.object({
		authenticated: z.boolean(),
		pending: z.boolean(),
		token: z.string().nullable(),
		userCode: z.string().nullable(),
		verificationUri: z.string().nullable(),
		lastFlow: coreDeviceFlowOutcomeSchema.nullable().optional(),
	})
	.passthrough();

export const coreAuthStatusWireSchema = z.custom<
	z.output<typeof coreAuthStatusFields> &
		z.output<typeof appResponseValueSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		coreAuthStatusFields.safeParse(value).success
);
export type CoreAuthStatusWire = z.output<typeof coreAuthStatusWireSchema>;
