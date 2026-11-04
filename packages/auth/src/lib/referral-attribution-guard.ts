import { APIError } from "better-auth/api";
import { z } from "zod";

/*
 * Referral attribution is fixed at sign-up.
 *
 * `referredBy` is a Better Auth `input: true` user field so the sign-up request
 * can carry the `?ref=` code the person arrived with. Better Auth's
 * `/update-user` accepts every `input: true` field too, which would let a
 * signed-in user attach or repoint their referrer later and route affiliate
 * commissions and referral credit to an account of their choosing. This guard
 * refuses a `/update-user` body that names `referredBy` at all.
 */

const SELF_UPDATE_PATH = "/update-user";

const referredByBodySchema = z.looseObject({}).nullish();

/** The fields of a Better Auth hook context the guard reads. */
export interface ReferralAttributionGuardContext {
	readonly body?: unknown;
	readonly path?: string;
}

export const REFERRED_BY_IMMUTABLE_MESSAGE =
	"referredBy is set at sign-up and cannot be changed";

/** Reject a self-service user update that tries to write `referredBy`. */
export function rejectReferredByUpdate(
	ctx: ReferralAttributionGuardContext
): void {
	if (ctx.path !== SELF_UPDATE_PATH) {
		return;
	}
	const body = referredByBodySchema.safeParse(ctx.body);
	if (!(body.success && body.data && Object.hasOwn(body.data, "referredBy"))) {
		return;
	}
	throw new APIError("BAD_REQUEST", {
		message: REFERRED_BY_IMMUTABLE_MESSAGE,
	});
}
