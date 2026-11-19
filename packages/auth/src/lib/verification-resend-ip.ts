import { baseAuthOptions } from "../auth-options/base-options.ts";
import {
	claimIpRequest,
	type IpLimitResult,
	limitIp,
} from "./client-ip-limit.ts";

// The per-client-IP limit on the signed-out verification resend
// (`POST /api/user/resend-verification`), checked before the address's
// request budget is claimed (lib/verification-resend.ts).

/**
 * Three signed-out resends per client IP per fixed one-minute window,
 * fleet-wide. Fixed, not sliding: a burst across a window boundary can reach
 * six.
 */
export const RESEND_VERIFICATION_IP_RULE = {
	max: 3,
	windowMs: 60_000,
} as const;

export const RESEND_VERIFICATION_IP_SCOPE = "resend-verification";

/**
 * Admit one resend for the request's client IP. Keyed by the IP alone,
 * resolved with the same `advanced.ipAddress` options as Better Auth's own
 * limiter, so a refusal never depends on the address or on whether an
 * account holds it. Store errors propagate.
 */
export async function admitVerificationResendIp(
	request: Request | Headers
): Promise<IpLimitResult> {
	return await claimIpRequest(
		RESEND_VERIFICATION_IP_SCOPE,
		limitIp(request, baseAuthOptions),
		RESEND_VERIFICATION_IP_RULE
	);
}
