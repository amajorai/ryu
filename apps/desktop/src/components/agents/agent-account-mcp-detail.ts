import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * The detail line of an MCP sign-in row in Agent > Account access: the signed-in
 * account, then its auth profile as one whole translated message (`Profil
 * work` in German), joined with the panel's ` · ` separator.
 */
export function mcpConnectionDetail(
	accountLabel: string | null | undefined,
	profileId: string,
	tl: LiteralMessage
): string {
	return [accountLabel, tl("Profile {id}", { id: profileId })]
		.filter(Boolean)
		.join(" · ");
}
