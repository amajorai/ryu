import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	type getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";
import {
	AGE_ELIGIBILITY_SECONDS,
	CURRENT_TERMS_VERSION,
	meetsMinimumAccountAge,
} from "./age-eligibility.ts";
import { isOrganizationSsoProvisioning } from "./age-eligibility-sso.ts";

const COOKIE_NAME = "age_eligibility";
const VALID_FOR_SECONDS = AGE_ELIGIBILITY_SECONDS;

type AgeContext = Pick<
	Parameters<typeof getAuthoritativeSessionFromCtx>[0],
	"context" | "getSignedCookie"
>;

/**
 * The signed cookie carries `<expiresAtMs>:<termsVersion>`: proof that this
 * browser passed the age check and accepted the current Terms and Privacy
 * Notice within the eligibility window. The birth date itself is never stored.
 */
function eligibilityCookieValue(expiresAt: number): string {
	return `${expiresAt}:${CURRENT_TERMS_VERSION}`;
}

/** Returns the accepted terms version when the cookie is valid. */
async function requireAgeEligibility(ctx: AgeContext | null): Promise<string> {
	const cookie = ctx?.context.createAuthCookie(COOKIE_NAME);
	const value =
		cookie && (await ctx?.getSignedCookie(cookie.name, ctx.context.secret));
	const [rawExpiresAt = "", termsVersion = ""] = z
		.string()
		.catch("")
		.parse(value)
		.split(":");
	const expiresAt = Number(rawExpiresAt);
	if (
		!Number.isFinite(expiresAt) ||
		expiresAt <= Date.now() ||
		expiresAt > Date.now() + VALID_FOR_SECONDS * 1000 ||
		termsVersion !== CURRENT_TERMS_VERSION
	) {
		throw new APIError("FORBIDDEN", {
			code: "AGE_ELIGIBILITY_REQUIRED",
			message:
				"Complete the age check and accept the Terms on the sign-up page before creating an account.",
		});
	}
	return termsVersion;
}

const ORGANIZATION_PROVISIONING_PATHS = new Set([
	"/admin/create-user",
	"/scim/v2/Users",
]);

export function ageEligibilityPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-age-eligibility",
		schema: {
			user: {
				fields: {
					// Stamped by the user-create hook below from the signed sign-up
					// cookie; never accepted from a request body.
					termsAcceptedAt: { type: "date", required: false, input: false },
					termsVersion: { type: "string", required: false, input: false },
				},
			},
		},
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/sign-up/email",
					handler: createAuthMiddleware(async (ctx) => {
						await requireAgeEligibility(ctx);
					}),
				},
			],
		},
		init: () => ({
			options: {
				databaseHooks: {
					user: {
						create: {
							before: async (user, ctx) => {
								// Existing authenticated staff/SCIM provisioning remains an
								// organization responsibility, rather than a public signup path.
								if (
									ctx &&
									(ORGANIZATION_PROVISIONING_PATHS.has(ctx.path) ||
										(await isOrganizationSsoProvisioning(ctx, user)))
								) {
									return;
								}
								const termsVersion = await requireAgeEligibility(ctx);
								// Record the acceptance on the account itself, for email and
								// social sign-up alike.
								return {
									data: {
										...user,
										termsAcceptedAt: new Date(),
										termsVersion,
									},
								};
							},
						},
					},
				},
			},
		}),
		endpoints: {
			checkAgeEligibility: createAuthEndpoint(
				"/age-eligibility",
				{
					method: "POST",
					body: z.object({
						dateOfBirth: z.string().max(10),
						// The sign-up form requires an explicit checkbox before this call.
						acceptedTerms: z.literal(true),
					}),
					metadata: { noStore: true },
				},
				async (ctx) => {
					const cookie = ctx.context.createAuthCookie(COOKIE_NAME, {
						maxAge: VALID_FOR_SECONDS,
					});
					const previous = await ctx.getSignedCookie(
						cookie.name,
						ctx.context.secret
					);
					if (
						previous === "denied" ||
						!meetsMinimumAccountAge(ctx.body.dateOfBirth)
					) {
						// Invalidate any previous eligibility, including on a second attempt.
						await ctx.setSignedCookie(
							cookie.name,
							"denied",
							ctx.context.secret,
							cookie.attributes
						);
						throw new APIError("FORBIDDEN", {
							code: "AGE_NOT_ELIGIBLE",
							message: "You are not eligible to create a Ryu account.",
						});
					}
					await ctx.setSignedCookie(
						cookie.name,
						eligibilityCookieValue(Date.now() + VALID_FOR_SECONDS * 1000),
						ctx.context.secret,
						cookie.attributes
					);
					return ctx.json({ eligible: true });
				}
			),
		},
	} satisfies BetterAuthPlugin;
}
