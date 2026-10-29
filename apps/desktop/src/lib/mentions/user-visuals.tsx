import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import type { ReactNode } from "react";
import type { MentionTargetUser } from "@/src/lib/api/notifications.ts";

function safeAvatarUrl(value: string | null): string | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

export function userInitials(name: string): string {
	return (
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

/** The compact avatar shared by the @ menu, composer token, and transcript. */
export function userMentionVisual(
	user: Pick<MentionTargetUser, "image" | "name">
): ReactNode {
	const image = safeAvatarUrl(user.image);
	return (
		<Avatar aria-label={`${user.name} avatar`} className="shrink-0" size="xs">
			{image ? <AvatarImage alt="" src={image} /> : null}
			<AvatarFallback>{userInitials(user.name)}</AvatarFallback>
		</Avatar>
	);
}
