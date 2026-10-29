import { createAccountLocaleSync } from "@ryu/i18n/account-locale";
import { authClient } from "@/lib/auth-client.ts";

/**
 * Save a language the person picked in Desktop on their cloud account, so
 * email from Ryu uses it (`AccountLocaleSync` decides when). Desktop
 * authenticates with a bearer token, so there is no `locale` cookie to
 * write. Debounced and fire-and-forget (`@ryu/i18n/account-locale`).
 */
export const saveAccountLocale = createAccountLocaleSync({
	isSignedIn: async () => {
		const { data } = await authClient.getSession();
		return Boolean(data?.user && !data.user.isAnonymous);
	},
	// Desktop's client does not infer `locale`, so call the endpoint directly.
	saveLocale: (locale) =>
		authClient.$fetch("/update-user", { method: "POST", body: { locale } }),
	onError: (error) => {
		console.warn("Failed to save the account language:", error);
	},
});
