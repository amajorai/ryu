export const INVITE_FRIEND_NAV_ITEM = {
	label: "Invite a friend",
	path: "/referrals",
} as const;

/**
 * Community Discord entry for signed-in menus. The page mints a personal,
 * single-use invite, so there is deliberately no public discord.gg link.
 */
export const JOIN_DISCORD_NAV_ITEM = {
	label: "Join Discord",
	path: "/discord",
} as const;
