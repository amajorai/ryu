import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { emailHarmony } from "better-auth-harmony";

/**
 * Normalize provider aliases for email sign-in and recovery while keeping the
 * address returned to users as the address they registered. The server-side
 * plugin also rejects disposable mailboxes on the email-auth endpoints it
 * owns. `normalizedEmail` is an internal lookup key, not a client field.
 */
const harmony = emailHarmony({
	allowNormalizedSignin: true,
});

// Route normalized collisions through Better Auth's generic creation-denied
// response without rewriting the submitted address (which itself leaks identity).
export const ryuEmailHarmony = {
	...harmony,
	init: () => ({
		options: {
			databaseHooks: {
				user: {
					create: {
						before: async (user, ctx) => {
							const normalized = await harmony
								.init()
								.options.databaseHooks.user.create.before(user);
							if (!normalized) {
								return false;
							}
							if (
								ctx?.path === "/sign-up/email" &&
								"normalizedEmail" in normalized.data
							) {
								const transaction =
									await getCurrentDBAdapterAsyncLocalStorage();
								const adapter =
									transaction.getStore()?.adapter ?? ctx.context.adapter;
								const existing = await adapter.findOne<typeof user>({
									model: "user",
									where: [
										{
											field: "normalizedEmail",
											value: normalized.data.normalizedEmail,
										},
									],
								});
								if (existing) {
									if (
										ctx.context.options.emailAndPassword
											?.requireEmailVerification
									) {
										const notify =
											ctx.context.options.emailAndPassword.onExistingUserSignUp;
										if (notify && ctx.request) {
											await ctx.context.runInBackgroundOrAwait(
												notify({ user: existing }, ctx.request)
											);
										}
										throw new APIError("FORBIDDEN", {
											message: "Unable to create user",
										});
									}
									throw new APIError("UNPROCESSABLE_ENTITY", {
										code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
										message: "User already exists. Use another email.",
									});
								}
							}
							return normalized;
						},
					},
					update: harmony.init().options.databaseHooks.user.update,
				},
			},
		},
	}),
} satisfies BetterAuthPlugin;
