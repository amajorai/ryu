/**
 * Social providers that can be linked to one Ryu user account from Settings.
 * Telegram is intentionally absent: its hosted login belongs to the
 * organization/channel identity flow, not a 1:1 Ryu account binding.
 */
export const ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS = [
	"google",
	"github",
	"discord",
] as const;

export type AccountLinkingSocialProviderId =
	(typeof ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS)[number];

/** The only social provider exposed by the public sign-in flow. */
export const SOCIAL_SIGN_IN_PROVIDER = "google" as const;

export function isAllowedSocialSignInProvider(provider: unknown): boolean {
	return provider === SOCIAL_SIGN_IN_PROVIDER;
}
