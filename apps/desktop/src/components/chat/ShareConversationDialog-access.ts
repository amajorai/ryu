import type {
	ConversationAccess,
	ConversationAccessRole,
} from "@/src/lib/api/conversation-sharing.ts";

export type GeneralAccess = ConversationAccess["visibility"] | "public";

/**
 * The signed-in owner as the share sections render it. Structural so both the
 * desktop vault account and the extension's token-free `Account` satisfy it;
 * the sections never need (and must not receive) the bearer token.
 */
export interface ShareOwner {
	email: string;
	image?: string | null;
	name?: string | null;
}

export function initials(name: string): string {
	return (
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

export function isGeneralAccess(value: string | null): value is GeneralAccess {
	return ["private", "org", "team", "public"].includes(String(value));
}

export function isAccessRole(
	value: string | null
): value is ConversationAccessRole {
	return value === "viewer" || value === "participant";
}
