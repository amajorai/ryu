import { useLiteralMessages } from "@ryu/i18n/react";
import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail.tsx";
import { useReducedMotion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import {
	isNativeFunction,
	isNativeText,
} from "../../lib/native-primitive-observation.ts";
import {
	getMessagePreview,
	RAIL_COLLAPSE_ITEM_COUNT,
} from "./message-scroller-rail.tsx";
import type { MessageScrollerBaseScope } from "./message-scroller-scope.ts";

export type UseMessageScrollerRailInput = MessageScrollerBaseScope;

/** Viewport refs, follow and unread state, and the preview rail's item sync. */
export function useMessageScrollerRail({
	followOutput,
	navigation,
	viewportProps,
	viewportRef: externalViewportRef,
	onFollowChange,
	showUnreadMessages,
	followThreshold,
	railItems: externalRailItems,
}: UseMessageScrollerRailInput) {
	const reduce = useReducedMotion() ?? false;
	const tl = useLiteralMessages();
	// Read through a ref so a fresh `tl` each render does not re-create the
	// rail sync callbacks (and with them the rail observers).
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const viewportRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(followOutput);
	const knownMessageIdsRef = useRef<Set<string>>(new Set());
	const programmaticScrollRef = useRef(false);
	const lastScrollTopRef = useRef(0);
	const scrollTimerRef = useRef<number | undefined>(undefined);
	const frameRef = useRef<number | undefined>(undefined);
	const railFrameRef = useRef<number | undefined>(undefined);
	const railIdRef = useRef(new WeakMap<HTMLElement, string>());
	const railIdCounterRef = useRef(0);
	const railTargetsRef = useRef(new Map<string, HTMLElement>());
	const [railItems, setRailItems] = useState<PreviewRailItem[]>([]);
	const [activeRailId, setActiveRailId] = useState("");
	const [railOverflowing, setRailOverflowing] = useState(false);
	const [following, setFollowingState] = useState(followOutput);
	const [newMessageCount, setNewMessageCount] = useState(0);
	const [unreadStartId, setUnreadStartId] = useState<string | null>(null);
	const railCollapsed =
		navigation === "rail" &&
		railOverflowing &&
		railItems.length > RAIL_COLLAPSE_ITEM_COUNT;
	const {
		onScroll: onViewportScroll,
		onWheel: onViewportWheel,
		onTouchStart: onViewportTouchStart,
		onKeyDown: onViewportKeyDown,
		...restViewportProps
	} = viewportProps ?? {};

	const setViewportRef = useCallback(
		(node: HTMLElement | null) => {
			viewportRef.current = node;
			if (isNativeFunction(externalViewportRef)) {
				externalViewportRef(node);
			} else if (externalViewportRef) {
				externalViewportRef.current = node;
			}
		},
		[externalViewportRef]
	);

	const clearUnreadMessages = useCallback(() => {
		setNewMessageCount((current) => (current === 0 ? current : 0));
		setUnreadStartId((current) => (current === null ? current : null));
	}, []);

	const setFollowing = useCallback(
		(next: boolean) => {
			if (followingRef.current === next) {
				if (next) {
					clearUnreadMessages();
				}
				return;
			}
			followingRef.current = next;
			setFollowingState(next);
			if (next) {
				clearUnreadMessages();
			}
			onFollowChange?.(next);
		},
		[clearUnreadMessages, onFollowChange]
	);

	const syncUnreadMessages = useCallback(() => {
		if (!showUnreadMessages) {
			return;
		}
		const content = contentRef.current;
		if (!content) {
			return;
		}

		const messageIds = Array.from(content.children)
			.filter(
				(node): node is HTMLElement =>
					node instanceof HTMLElement &&
					node.dataset.slot === "message-scroller-item" &&
					isNativeText(node.dataset.messageId) &&
					node.dataset.messageId.length > 0
			)
			.map((node) => {
				// SAFETY: actual DOMStringMap values are strings when present. The native
				// attribute was checked above; no mutation or callback intervenes in
				// this synchronous native child-list observation. Keep its final read.
				return node.dataset.messageId as string;
			});
		const knownMessageIds = knownMessageIdsRef.current;
		const addedMessageIds = messageIds.filter((id) => !knownMessageIds.has(id));

		if (followingRef.current) {
			clearUnreadMessages();
		} else if (addedMessageIds.length > 0) {
			setNewMessageCount((current) => current + addedMessageIds.length);
			setUnreadStartId((current) => current ?? addedMessageIds[0] ?? null);
		}

		knownMessageIdsRef.current = new Set(messageIds);
	}, [clearUnreadMessages, showUnreadMessages]);

	const updateActiveRailItem = useCallback(() => {
		if (navigation !== "rail") {
			return;
		}
		const viewport = viewportRef.current;
		const targets = [...railTargetsRef.current.entries()];
		if (!viewport || targets.length === 0) {
			return;
		}

		const viewportRect = viewport.getBoundingClientRect();
		if (viewport.scrollTop <= followThreshold) {
			const firstId = targets[0]?.[0] ?? "";
			setActiveRailId((current) => (current === firstId ? current : firstId));
			return;
		}

		const distanceFromEnd =
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		if (distanceFromEnd <= followThreshold) {
			const lastId = targets.at(-1)?.[0] ?? "";
			setActiveRailId((current) => (current === lastId ? current : lastId));
			return;
		}

		const viewportCenter = viewportRect.top + viewportRect.height / 2;
		let nearestId = targets[0]?.[0] ?? "";
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (const [id, element] of targets) {
			const rect = element.getBoundingClientRect();
			const messageCenter = rect.top + rect.height / 2;
			const distance = Math.abs(messageCenter - viewportCenter);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestId = id;
			}
		}

		setActiveRailId((current) => (current === nearestId ? current : nearestId));
	}, [followThreshold, navigation]);

	const syncRailItems = useCallback(() => {
		if (navigation !== "rail") {
			return;
		}
		const content = contentRef.current;
		const viewport = viewportRef.current;
		if (!(content && viewport)) {
			return;
		}

		// Consumer-supplied rail: use the items verbatim and resolve each row's
		// scroll target by its `data-message-id`. The rich preview (files, agent,
		// description) is the caller's business; this only needs the DOM anchor.
		if (externalRailItems) {
			const targets = new Map<string, HTMLElement>();
			for (const item of externalRailItems) {
				const el = content.querySelector<HTMLElement>(
					`[data-message-id="${CSS.escape(item.id)}"]`
				);
				if (el) {
					targets.set(item.id, el);
				}
			}
			railTargetsRef.current = targets;
			setRailItems((current) => {
				const unchanged =
					current.length === externalRailItems.length &&
					current.every(
						(item, index) =>
							item.id === externalRailItems[index]?.id &&
							item.label === externalRailItems[index]?.label &&
							item.description === externalRailItems[index]?.description
					);
				return unchanged ? current : externalRailItems;
			});
			setRailOverflowing(
				viewport.scrollHeight > viewport.clientHeight + 1 &&
					externalRailItems.length > 1
			);
			return;
		}

		const messages = Array.from(
			content.querySelectorAll<HTMLElement>('[data-slot="message"]')
		);
		const targets = new Map<string, HTMLElement>();
		const nextItems = messages.map((message, index) => {
			let id = railIdRef.current.get(message);
			if (!id) {
				railIdCounterRef.current += 1;
				id = `message-rail-${railIdCounterRef.current}`;
				railIdRef.current.set(message, id);
			}
			targets.set(id, message);
			const sender = message.dataset.from ?? "conversation";
			const assistantResponse =
				sender === "user"
					? messages
							.slice(index + 1)
							.find((candidate) => candidate.dataset.from === "assistant")
					: undefined;
			const preview = getMessagePreview(message, assistantResponse);

			return {
				id,
				label: preview.label,
				description: preview.description,
				ariaLabel: tlRef.current(
					"Go to {sender} message {position} of {total}",
					{
						sender,
						position: String(index + 1),
						total: String(messages.length),
					}
				),
			};
		});

		railTargetsRef.current = targets;
		setRailItems((current) => {
			const unchanged =
				current.length === nextItems.length &&
				current.every(
					(item, index) =>
						item.id === nextItems[index]?.id &&
						item.label === nextItems[index]?.label &&
						item.description === nextItems[index]?.description &&
						item.ariaLabel === nextItems[index]?.ariaLabel
				);
			return unchanged ? current : nextItems;
		});
		setRailOverflowing(
			viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1
		);
	}, [externalRailItems, navigation]);

	const scheduleRailSync = useCallback(() => {
		if (navigation !== "rail") {
			return;
		}
		if (railFrameRef.current) {
			cancelAnimationFrame(railFrameRef.current);
		}
		railFrameRef.current = requestAnimationFrame(() => {
			syncRailItems();
			updateActiveRailItem();
		});
	}, [navigation, syncRailItems, updateActiveRailItem]);
	return {
		reduce,
		viewportRef,
		contentRef,
		followingRef,
		programmaticScrollRef,
		lastScrollTopRef,
		scrollTimerRef,
		frameRef,
		railFrameRef,
		railTargetsRef,
		railItems,
		setRailItems,
		activeRailId,
		setActiveRailId,
		railOverflowing,
		setRailOverflowing,
		following,
		newMessageCount,
		unreadStartId,
		railCollapsed,
		onViewportScroll,
		onViewportWheel,
		onViewportTouchStart,
		onViewportKeyDown,
		restViewportProps,
		setViewportRef,
		setFollowing,
		syncUnreadMessages,
		updateActiveRailItem,
		scheduleRailSync,
	} as const;
}
