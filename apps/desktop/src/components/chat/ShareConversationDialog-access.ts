import type {
	ConversationAccess,
	ConversationAccessRole,
} from "@/src/lib/api/conversation-sharing.ts";

export type GeneralAccess = ConversationAccess["visibility"] | "public";

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
