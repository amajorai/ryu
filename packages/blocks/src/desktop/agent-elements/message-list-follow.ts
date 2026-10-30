import { cn } from "@ryu/ui/lib/utils";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { usePinnedUserMessage } from "./hooks/use-pinned-user-message.ts";
import {
	type BubbleEntranceState,
	reconcileBubbleEntranceState,
} from "./message-list-entrance.ts";
import type { MessageListBaseScope } from "./message-list-scope.ts";
import {
	clearUnreadMessageState,
	getIncomingMessageIds,
	getUnreadMessageLabel,
	reconcileUnreadMessageState,
	type UnreadMessageState,
} from "./message-list-unread.ts";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer.tsx";
import { UserMessage } from "./user-message.tsx";
import { normalizeMessages } from "./utils/live-message-observations.ts";

export type UseMessageListFollowInput = MessageListBaseScope;

/** Follow-at-the-live-edge scrolling, unread tracking and bubble entrance state. */
export function useMessageListFollow({
	classNames,
	className,
	statsPluginEnabled,
	initialScrollBehavior,
	onLoadOlderMessages,
	hasOlderMessages,
	loadingOlderMessages,
	messages,
	slots,
	status,
	conversationKey,
}: UseMessageListFollowInput) {
	// This shared composite exposes its actual native root ref, but no render
	// slot. Its open classNames producer contract belongs to this root, not an
	// outer wrapper or a viewport. Apply the inspected canonical root recipe at
	// that native boundary so caller overrides retain the original cn order.
	// A new callback on either carrier change updates the same mounted root;
	// internal scroller rerenders keep their static class recipe unchanged.
	const ownScrollerRootClasses = useCallback(
		(node: HTMLDivElement | null) => {
			if (node) {
				node.className = cn(
					"relative min-h-0 flex-1",
					classNames?.messageList,
					className
				);
			}
		},
		[classNames?.messageList, className]
	);

	const [activeCopyId, setActiveCopyId] = useState<string | null>(null);
	// Which user message is currently in inline-edit mode (null = none).
	const [editingId, setEditingId] = useState<string | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	// Whether the reader is at the live edge of the transcript — driven by the
	// beUI scroller's `onFollowChange`. `false` is when the scroll-to-end button
	// appears.
	const [following, setFollowing] = useState(true);
	const scrollerRef = useRef<HTMLDivElement>(null);
	// The beUI MessageScroller's scrollable viewport. Forwarded via
	// `viewportRef` so the pinned bar, the floating date header and the TOC can
	// read scroll position without owning the scroller.
	const viewportRef = useRef<HTMLElement | null>(null);
	const {
		animationsEnabled,
		density,
		hideToolDetail,
		inferenceStats,
		openAtBottom,
		pinUserMessage,
	} = useChatDisplayPrefs();
	const statsEnabled = statsPluginEnabled && inferenceStats;
	const followOutput = openAtBottom && initialScrollBehavior !== "top";
	const followingRef = useRef(true);
	const unreadStateRef = useRef<UnreadMessageState | null>(null);
	const unreadMarkerRef = useRef<HTMLDivElement | null>(null);
	const preserveUnreadBoundaryRef = useRef(false);
	const [unreadMessageIds, setUnreadMessageIds] = useState<string[]>([]);
	const clearUnreadBoundaryPreservation = useCallback(() => {
		preserveUnreadBoundaryRef.current = false;
	}, []);
	// A narrow surface (island mini-chat, companion popover) renders the same
	// parts with tighter padding. The shared preview rail remains available; its
	// own overflow behavior collapses it to a popover when the surface is narrow.
	const isCompact = density === "compact";

	const clearUnreadMessages = useCallback(() => {
		const state = unreadStateRef.current;
		if (!state || state.unreadIds.length === 0) {
			return;
		}
		unreadStateRef.current = clearUnreadMessageState(state);
		setUnreadMessageIds([]);
	}, []);

	const handleFollowChange = useCallback(
		(next: boolean) => {
			if (next && preserveUnreadBoundaryRef.current) {
				return;
			}
			followingRef.current = next;
			setFollowing(next);
			if (next) {
				clearUnreadMessages();
			}
		},
		[clearUnreadMessages]
	);
	const olderLoadInFlightRef = useRef(false);
	const handleViewportScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			const viewport = event.currentTarget;
			if (
				!(onLoadOlderMessages && hasOlderMessages) ||
				loadingOlderMessages ||
				viewport.scrollTop > 96 ||
				olderLoadInFlightRef.current
			) {
				return;
			}
			olderLoadInFlightRef.current = true;
			const previousHeight = viewport.scrollHeight;
			const previousTop = viewport.scrollTop;
			void onLoadOlderMessages()
				.then(() => {
					const restoreScrollAnchor = (framesRemaining: number) => {
						if (!viewport.isConnected || framesRemaining <= 0) {
							return;
						}
						viewport.scrollTop =
							previousTop + viewport.scrollHeight - previousHeight;
						window.requestAnimationFrame(() =>
							restoreScrollAnchor(framesRemaining - 1)
						);
					};
					window.requestAnimationFrame(() => restoreScrollAnchor(8));
				})
				.finally(() => {
					olderLoadInFlightRef.current = false;
				});
		},
		[hasOlderMessages, loadingOlderMessages, onLoadOlderMessages]
	);

	useEffect(() => {
		followingRef.current = followOutput;
		setFollowing(followOutput);
		if (followOutput) {
			clearUnreadMessages();
		}
	}, [clearUnreadMessages, followOutput]);

	const {
		isScrollingUp,
		pinnedMessage,
		registerAnchor,
		scrollToPinned,
		setScrollDirection,
	} = usePinnedUserMessage({
		enabled: pinUserMessage && !isCompact,
		messages,
		scrollerRef,
	});

	const CustomUserMessage = slots?.UserMessage || UserMessage;
	const CustomToolRenderer = slots?.ToolRenderer || DefaultToolRenderer;

	const markCopied = useCallback((id: string) => {
		setActiveCopyId(id);
	}, []);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	useEffect(() => {
		const handlePointerDown = () => {
			setActiveCopyId(null);
		};
		window.addEventListener("pointerdown", handlePointerDown);
		return () => window.removeEventListener("pointerdown", handlePointerDown);
	}, []);

	const isStreaming = status === "streaming" || status === "submitted";

	const normalizedMessages = useMemo(
		() => normalizeMessages(messages),
		[messages]
	);
	const conversationStateKey =
		conversationKey ?? normalizedMessages[0]?.id ?? null;

	// Bubbles that arrive while the list is on screen pop in; loaded history
	// never does. Derived from the last COMMITTED state so a render React
	// discards cannot advance it; see `message-list-entrance.ts`.
	const bubbleEntranceRef = useRef<BubbleEntranceState | null>(null);
	const bubbleEntrance = useMemo(
		() =>
			reconcileBubbleEntranceState(
				bubbleEntranceRef.current,
				conversationKey ?? null,
				normalizedMessages.map((message) => message.id)
			),
		[conversationKey, normalizedMessages]
	);
	useEffect(() => {
		bubbleEntranceRef.current = bubbleEntrance;
	}, [bubbleEntrance]);
	const isBubbleEntering = (id: string | undefined): boolean =>
		animationsEnabled && id !== undefined && bubbleEntrance.freshIds.has(id);
	useEffect(() => {
		const nextState = reconcileUnreadMessageState(
			unreadStateRef.current,
			conversationStateKey,
			getIncomingMessageIds(normalizedMessages),
			followingRef.current && !preserveUnreadBoundaryRef.current
		);
		unreadStateRef.current = nextState;
		setUnreadMessageIds((current) => {
			if (
				current.length === nextState.unreadIds.length &&
				current.every((id, index) => id === nextState.unreadIds[index])
			) {
				return current;
			}
			return [...nextState.unreadIds];
		});
	}, [conversationStateKey, normalizedMessages]);

	const unreadMessageIdSet = useMemo(
		() => new Set(unreadMessageIds),
		[unreadMessageIds]
	);
	const firstUnreadMessageId = useMemo(
		() =>
			normalizedMessages.find(
				(message) =>
					message.role === "assistant" && unreadMessageIdSet.has(message.id)
			)?.id ?? null,
		[normalizedMessages, unreadMessageIdSet]
	);
	const unreadMessageCount = unreadMessageIds.length;
	const unreadMessageLabel = getUnreadMessageLabel(unreadMessageCount);

	useEffect(() => {
		if (!(unreadMessageCount > 0 && firstUnreadMessageId)) {
			return;
		}
		const marker = unreadMarkerRef.current;
		const viewport = viewportRef.current;
		if (!(marker && viewport)) {
			return;
		}
		const clearAtUnreadBoundary = () => {
			if (preserveUnreadBoundaryRef.current) {
				return;
			}
			clearUnreadMessages();
			// Reaching the marker is not the same as choosing the live edge. The
			// browser may place a marker near the end of a short transcript at the
			// bottom when it is revealed; keep the latest-message affordance visible
			// until the reader explicitly follows the newest reply.
			if (followingRef.current) {
				followingRef.current = false;
				setFollowing(false);
			}
			preserveUnreadBoundaryRef.current = true;
		};

		const clearWhenVisible = () => {
			const markerRect = marker.getBoundingClientRect();
			const viewportRect = viewport.getBoundingClientRect();
			if (
				markerRect.top < viewportRect.bottom &&
				markerRect.bottom > viewportRect.top
			) {
				clearAtUnreadBoundary();
			}
		};

		const observer =
			globalThis.IntersectionObserver === undefined
				? null
				: new IntersectionObserver(
						(entries) => {
							if (entries.some((entry) => entry.isIntersecting)) {
								clearAtUnreadBoundary();
							}
						},
						{ root: viewport, threshold: 0.1 }
					);
		observer?.observe(marker);
		viewport.addEventListener("scroll", clearWhenVisible, { passive: true });
		clearWhenVisible();

		return () => {
			observer?.disconnect();
			viewport.removeEventListener("scroll", clearWhenVisible);
		};
	}, [clearUnreadMessages, firstUnreadMessageId, unreadMessageCount]);
	return {
		ownScrollerRootClasses,
		activeCopyId,
		editingId,
		setEditingId,
		isMounted,
		following,
		scrollerRef,
		viewportRef,
		animationsEnabled,
		hideToolDetail,
		openAtBottom,
		pinUserMessage,
		statsEnabled,
		followOutput,
		unreadMarkerRef,
		preserveUnreadBoundaryRef,
		clearUnreadBoundaryPreservation,
		isCompact,
		handleFollowChange,
		handleViewportScroll,
		isScrollingUp,
		pinnedMessage,
		registerAnchor,
		scrollToPinned,
		setScrollDirection,
		CustomUserMessage,
		CustomToolRenderer,
		markCopied,
		isStreaming,
		normalizedMessages,
		isBubbleEntering,
		firstUnreadMessageId,
		unreadMessageCount,
		unreadMessageLabel,
	} as const;
}
