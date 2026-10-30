// Menu actions for a sidebar chat row that own async work: auto-rename, the
// learning-privacy toggle, app-contributed rows and the node handoff.
// Called only by `ChatRow`, so every hook here is still that row's hook.

import { toast } from "@ryu/ui/components/sileo.tsx";
import { resolveRnpNode } from "@ryuhq/protocol/continuity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatHistoryRowActions } from "@/src/contexts/ChatHistoryContext.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	clearRnpContinued,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import {
	getConversationLearningExclusion,
	setConversationLearningExclusion,
} from "@/src/lib/api/learn.ts";
import {
	type PluginContextMenuItem,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import type { ChatRowHandlers } from "./sidebar-chat-row-types.ts";

export function useChatRowActions(
	conv: Conversation,
	handlers: ChatRowHandlers,
	chatHistory: ChatHistoryRowActions | null,
	/** True once one of the row's menus has opened; the learning-privacy
	 *  state is fetched only then, not for every row on mount. */
	menuOpened = true
) {
	const { onAutoRenameConversation, target } = handlers;
	const [isRetitling, setIsRetitling] = useState(false);
	const retitlingRef = useRef(false);
	const autoRename = () => {
		if (retitlingRef.current || !onAutoRenameConversation) {
			return;
		}
		retitlingRef.current = true;
		setIsRetitling(true);
		const pending = onAutoRenameConversation(conv.id).finally(() => {
			retitlingRef.current = false;
			setIsRetitling(false);
		});
		toast.promise(pending, {
			loading: "Renaming chat…",
			success: (title: string) => `Renamed to "${title}"`,
			error: (error) =>
				error instanceof ApiError
					? (error.serverMessage ?? "Couldn't auto-rename chat")
					: error instanceof Error
						? error.message
						: "Couldn't auto-rename chat",
		});
	};
	const [learningExcluded, setLearningExcluded] = useState(false);
	// Set once the user toggles: a read that lands after the toggle (the fetch
	// starts when the menu opens) must not overwrite the optimistic value.
	const learningTouchedRef = useRef(false);

	useEffect(() => {
		if (!menuOpened) {
			return;
		}
		let cancelled = false;
		learningTouchedRef.current = false;
		getConversationLearningExclusion(target, conv.id)
			.then(({ excluded }) => {
				if (!(cancelled || learningTouchedRef.current)) {
					setLearningExcluded(excluded);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [conv.id, menuOpened, target.token, target.url]);

	const toggleLearningExclusion = useCallback(() => {
		learningTouchedRef.current = true;
		const next = !learningExcluded;
		setLearningExcluded(next);
		setConversationLearningExclusion(target, conv.id, next).catch(() => {
			setLearningExcluded(!next);
			toast.error("Couldn't update this chat's learning privacy", {
				description: "Check your connection and try again.",
			});
		});
	}, [conv.id, learningExcluded, target.token, target.url]);
	const learningLabel = learningExcluded
		? "Include in learning"
		: "Exclude from learning";

	// App-registered conversation-menu rows from the contributions feed, filtered
	// to the `conversation` anchor. The "Make a skill from this chat" row is a
	// Learning contribution, not a hardcoded menu item — disabling the app removes
	// the row. Each row dispatches its declared capability through the owning
	// plugin's granted host seam (`pluginHostInvoke`), never inline code.
	const { context_menu_items } = usePluginContributions();
	const contributedMenuRows = useMemo(
		() =>
			context_menu_items
				.filter((item) => item.anchor === "conversation")
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				),
		[context_menu_items]
	);

	// One dispatcher, both surfaces. The ⋯ dropdown and the right-click menu are
	// separate primitives (`DropdownMenuItem` vs `ContextMenuItem`, so the rendered
	// rows genuinely cannot be shared), but the *action* must be defined once —
	// they had already drifted, with the right-click menu shipping no contributed
	// rows at all.
	const runContributedRow = useCallback(
		(item: PluginContextMenuItem) => {
			const feedback = item.feedback;
			const run = () =>
				pluginHostInvoke(target, item.plugin, item.capability ?? "", {
					...item.args,
					conversation_id: conv.id,
				});
			// `success` is passed unconditionally. That collapses what used to be two
			// branches here without changing behavior: `toastPromise` already falls
			// back to `loading` when `success` is omitted (`sileo.tsx`), so the
			// no-feedback case resolved to this exact label before too.
			toast.promise(run(), {
				loading: feedback?.loading ?? item.label,
				success: feedback?.success ?? item.label,
				error: feedback?.error ?? `${item.label} failed`,
			});
		},
		[conv.id, target]
	);

	const [handoff, setHandoff] = useState<{
		nodes: Node[];
		sourceNode: Node;
	} | null>(null);

	const openHandoff = () => {
		const nodes = useNodeStore.getState().nodes;
		const source = resolveRnpNode(target.url, nodes);
		if (source.kind === "blocked") {
			toast.error("This chat's source is not a configured node");
			return;
		}
		setHandoff({ nodes, sourceNode: source.node });
	};

	// Clear the "Continued on" marker so this computer owns the thread again.
	const takeBack = () => {
		const pending = clearRnpContinued(target, conv.id).then(() =>
			chatHistory?.refresh()
		);
		toast.promise(pending, {
			loading: "Taking the thread back…",
			success: "Thread taken back",
			error: (cause: unknown) =>
				workspaceErrorMessage(cause, "Could not take the thread back"),
		});
	};
	return {
		autoRename,
		contributedMenuRows,
		handoff,
		isRetitling,
		learningLabel,
		openHandoff,
		runContributedRow,
		setHandoff,
		takeBack,
		toggleLearningExclusion,
	};
}
