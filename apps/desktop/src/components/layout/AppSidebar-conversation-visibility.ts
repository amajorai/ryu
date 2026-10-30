import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useState } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import {
	resourceVisibilityForGroup,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";

/** The pending "change this chat's visibility" request and its confirmation. */
export function useConversationVisibilityRequest(
	canMakePrivate: ReturnType<typeof useVisibilityAdminAccess>["canMakePrivate"],
	setConversationVisibility: ReturnType<
		typeof useChatHistoryContext
	>["setConversationVisibility"]
) {
	const [pendingChatVisibility, setPendingChatVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [changingChatVisibility, setChangingChatVisibility] = useState(false);
	const requestConversationVisibility = useCallback(
		(request: VisibilityChangeRequest) => {
			if (request.to === "private" && !canMakePrivate) {
				toast.error(
					"Only organization admins can make shared resources private"
				);
				return;
			}
			setPendingChatVisibility(request);
		},
		[canMakePrivate]
	);
	const confirmConversationVisibility = useCallback(async () => {
		if (!pendingChatVisibility) {
			return;
		}
		if (pendingChatVisibility.to === "private" && !canMakePrivate) {
			toast.error("Only organization admins can make shared resources private");
			return;
		}
		setChangingChatVisibility(true);
		try {
			const success = await setConversationVisibility(
				pendingChatVisibility.id,
				resourceVisibilityForGroup(pendingChatVisibility.to)
			);
			if (success) {
				setPendingChatVisibility(null);
				return;
			}
			toast.error("Couldn't change this chat's visibility", {
				description: "The chat stayed in its current group.",
			});
		} catch {
			toast.error("Couldn't change this chat's visibility", {
				description: "The chat stayed in its current group.",
			});
		} finally {
			setChangingChatVisibility(false);
		}
	}, [canMakePrivate, pendingChatVisibility, setConversationVisibility]);
	return {
		changingChatVisibility,
		confirmConversationVisibility,
		pendingChatVisibility,
		requestConversationVisibility,
		setPendingChatVisibility,
	};
}
