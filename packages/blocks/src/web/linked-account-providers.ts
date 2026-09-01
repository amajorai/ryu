/**
 * Social identities that can be linked to one Ryu user account from Settings.
 * Telegram is intentionally absent because its hosted login is organization/
 * channel-scoped rather than a 1:1 Ryu account binding.
 */
export const ACCOUNT_LINKING_PROVIDERS = [
	{
		description: "Use your Google account for Ryu sign-in.",
		id: "google",
		label: "Google",
	},
	{
		description: "Link your GitHub identity to this Ryu account.",
		id: "github",
		label: "GitHub",
	},
	{
		description: "Link your Discord identity to this Ryu account.",
		id: "discord",
		label: "Discord",
	},
] as const;

export type LinkedAccountProvider =
	(typeof ACCOUNT_LINKING_PROVIDERS)[number]["id"];
