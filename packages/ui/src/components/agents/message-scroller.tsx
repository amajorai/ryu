"use client";

// beui.dev/components/agents/message-scroller

import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	PreviewRail,
	type PreviewRailItem,
} from "@ryu/ui/components/motion/preview-rail.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import {
	type ComponentPropsWithRef,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import {
	isNativeFunction,
	isNativeText,
} from "../../lib/native-primitive-observation.ts";

const PREVIEW_TITLE_LENGTH = 56;
const PREVIEW_DESCRIPTION_LENGTH = 88;
const RAIL_COLLAPSE_ITEM_COUNT = 18;

function truncateMessageText(text: string, limit: number) {
	if (text.length <= limit) {
		return text;
	}
	const excerpt = text.slice(0, limit);
	const boundary = excerpt.lastIndexOf(" ");
	return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

function getMessageText(message: HTMLElement) {
	const surface =
		message.querySelector<HTMLElement>(
			'[data-slot="message-bubble-content"]'
		) ??
		message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
		message;
	return (surface.textContent ?? "").replace(/\s+/g, " ").trim();
}

function getMessagePreview(
	message: HTMLElement,
	assistantResponse?: HTMLElement
) {
	const text = getMessageText(message);
	if (!text) {
		return { label: "Message", description: undefined };
	}

	if (text.length <= PREVIEW_TITLE_LENGTH) {
		const responseText = assistantResponse
			? getMessageText(assistantResponse)
			: "";
		return {
			label: text,
			description: responseText
				? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
				: undefined,
		};
	}

	const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH);
	const titleBoundary = titleExcerpt.lastIndexOf(" ");
	const titleEnd =
		titleBoundary > PREVIEW_TITLE_LENGTH * 0.65
			? titleBoundary
			: PREVIEW_TITLE_LENGTH;
	const label = `${text.slice(0, titleEnd).trim()}…`;
	const responseText = assistantResponse
		? getMessageText(assistantResponse)
		: text.slice(titleEnd).trim();
	return {
		label,
		description: responseText
			? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
			: undefined,
	};
}

function CollapsedMessageRail({
	items,
	activeId,
	onItemSelect,
}: {
	items: PreviewRailItem[];
	activeId: string;
	onItemSelect: (item: PreviewRailItem) => void;
}) {
	const [open, setOpen] = useState(false);
	const messageListRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const revealActiveItem = () => {
			const list = messageListRef.current;
			const activeItem = list?.querySelector<HTMLElement>(
				'[data-active="true"]'
			);
			if (!(list && activeItem)) {
				return;
			}
			list.scrollTop = Math.max(
				0,
				activeItem.offsetTop - (list.clientHeight - activeItem.offsetHeight) / 2
			);
		};
		const frame = window.requestAnimationFrame(revealActiveItem);
		const timer = window.setTimeout(revealActiveItem, 80);
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(timer);
		};
	}, [activeId, open]);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				aria-label={`Browse ${items.length} messages`}
				className="absolute top-1/2 left-1 z-20 flex h-[5.5rem] w-7 -translate-y-1/2 flex-col items-center justify-center gap-1.5 rounded-full border border-border/70 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				data-active-message-id={activeId}
				data-count={items.length}
				data-slot="message-navigation-collapsed-rail"
				title={`Browse ${items.length} messages`}
			>
				<span aria-hidden="true" className="flex flex-col items-center gap-1">
					<span className="h-px w-3 rounded-full bg-current/45" />
					<span className="h-px w-4 rounded-full bg-current/70" />
					<span className="h-px w-2.5 rounded-full bg-current/45" />
					<span className="h-px w-3.5 rounded-full bg-current/70" />
					<span className="h-px w-2 rounded-full bg-current/45" />
				</span>
				<span className="type-micro font-medium tabular-nums leading-none">
					{items.length > 99 ? "99+" : items.length}
				</span>
			</PopoverTrigger>
			<PopoverContent
				align="center"
				className="w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
				data-message-navigation-popover="true"
				side="right"
				sideOffset={10}
			>
				<div className="flex items-center justify-between border-border/60 border-b px-3 py-2.5">
					<div className="min-w-0">
						<p className="font-medium text-sm">Messages</p>
						<p className="text-muted-foreground text-xs">
							Jump to any message in this conversation
						</p>
					</div>
					<span className="type-compact shrink-0 rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground tabular-nums">
						{items.length}
					</span>
				</div>
				<ul
					aria-label="All messages"
					className="scroll-fade max-h-[min(70vh,32rem)] overflow-y-auto p-1"
					data-slot="message-navigation-list"
					ref={messageListRef}
				>
					{items.map((item, index) => {
						const active = item.id === activeId;
						return (
							<li key={item.id}>
								<button
									aria-current={active ? "true" : undefined}
									className={cn(
										"flex w-full items-start gap-2 rounded-2xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
										active && "bg-muted/80"
									)}
									data-active={active ? "true" : undefined}
									data-message-id={item.id}
									data-slot="message-navigation-item"
									onClick={() => {
										onItemSelect(item);
										setOpen(false);
									}}
									type="button"
								>
									<span
										aria-hidden="true"
										className={cn(
											"type-compact mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground tabular-nums",
											active && "bg-foreground text-background"
										)}
									>
										{index + 1}
									</span>
									<span className="min-w-0 flex-1">
										<span className="line-clamp-2 block font-medium text-xs leading-4">
											{item.label}
										</span>
										{item.description ? (
											<span className="type-caption mt-0.5 line-clamp-2 block text-muted-foreground leading-4">
												{item.description}
											</span>
										) : null}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
	/** Marks the transcript as waiting for more streamed content. */
	busy?: boolean;
	contentClassName?: string;
	contentInset?: "default" | "compact" | "transcript";
	contentProps?: Omit<
		ComponentPropsWithRef<"div">,
		"children" | "className" | "ref"
	> & { "data-slot"?: string };
	contentSpacing?: "default" | "flush";
	/** Keep streamed output pinned while the reader remains near the end. */
	followOutput?: boolean;
	/** Distance from the end that still counts as following the output. */
	followThreshold?: number;
	/** Accessible label for the scrollable transcript. */
	label?: string;
	/** Adds a compact rail for navigating between rendered Message rows. */
	navigation?: "rail";
	/** Accessible label for the optional message navigation rail. */
	navigationLabel?: string;
	/** Reports when the reader leaves or returns to the live edge. */
	onFollowChange?: (following: boolean) => void;
	railClassName?: string;
	/**
	 * Rich rail items supplied by the consumer instead of the auto-derived
	 * message previews. Each item's `id` is matched to a rendered row carrying
	 * `data-message-id={item.id}` for scroll targeting. When provided, the
	 * default text-preview derivation is skipped.
	 */
	railItems?: PreviewRailItem[];
	/** Custom preview card for the rail. Receives the item being hovered. */
	renderPreview?: (item: PreviewRailItem) => ReactNode;
	/** Render the shared scroll-to-latest control. */
	showScrollToLatest?: boolean;
	/** Track DOM message rows for the generic unread indicator. */
	showUnreadMessages?: boolean;
	/** Smoothly follow growing content. */
	smooth?: boolean;
	viewportClassName?: string;
	viewportProps?: Omit<
		ComponentPropsWithRef<"section">,
		"children" | "className" | "ref"
	> & { "data-slot"?: string };
	viewportRef?: Ref<HTMLElement>;
}

export function MessageScroller({
	followOutput = true,
	followThreshold = 56,
	smooth = true,
	onFollowChange,
	showScrollToLatest = true,
	showUnreadMessages = true,
	label = "Conversation",
	busy,
	navigation,
	railItems: externalRailItems,
	renderPreview,
	navigationLabel = "Message navigation",
	viewportClassName,
	contentClassName,
	contentInset = "default",
	contentSpacing = "default",
	railClassName,
	viewportRef: externalViewportRef,
	viewportProps,
	contentProps,
	className,
	children,
	...props
}: MessageScrollerProps) {
	const reduce = useReducedMotion() ?? false;
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
				ariaLabel: `Go to ${sender} message ${index + 1} of ${messages.length}`,
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

	const scrollToEnd = useCallback(
		(behavior: ScrollBehavior) => {
			const viewport = viewportRef.current;
			if (!viewport) {
				return;
			}

			setFollowing(true);
			programmaticScrollRef.current = true;
			if (isNativeFunction(viewport.scrollTo)) {
				viewport.scrollTo({ top: viewport.scrollHeight, behavior });
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			scrollTimerRef.current = window.setTimeout(
				() => {
					programmaticScrollRef.current = false;
					// Content that grew while the smooth scroll ran (a fast stream)
					// left the animation short of the new end; finish the follow.
					const current = viewportRef.current;
					if (
						followingRef.current &&
						current &&
						current.scrollHeight - current.scrollTop - current.clientHeight >
							followThreshold
					) {
						current.scrollTop = current.scrollHeight;
					}
				},
				behavior === "smooth" ? 320 : 0
			);
		},
		[followThreshold, setFollowing]
	);

	const handleScroll = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) {
			return;
		}

		const distance =
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		const movedUp = viewport.scrollTop < lastScrollTopRef.current;
		lastScrollTopRef.current = viewport.scrollTop;
		// Our own smooth follow passes through positions far from the end, and
		// the end moves while output streams in. Those frames are not the reader
		// leaving the live edge (wheel, touch, and keys clear the flag first).
		// The follow only ever moves DOWN, so an upward move that ends away from
		// the end is the reader leaving (scrollbar drag, Shift+Space, find in
		// page, autoscroll) even while the follow flag is still set. A shrinking
		// transcript clamps scrollTop to the end (distance 0), so it is excluded.
		if (
			programmaticScrollRef.current &&
			movedUp &&
			distance > followThreshold
		) {
			programmaticScrollRef.current = false;
		}
		if (!programmaticScrollRef.current || distance <= followThreshold) {
			setFollowing(distance <= followThreshold);
		}
		updateActiveRailItem();
	}, [followThreshold, setFollowing, updateActiveRailItem]);

	const leaveLiveEdge = useCallback(() => {
		programmaticScrollRef.current = false;
	}, []);

	useLayoutEffect(() => {
		setFollowing(followOutput);
		if (!followOutput) {
			return;
		}

		frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
		return () => {
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
		};
	}, [followOutput, scrollToEnd, setFollowing]);

	useEffect(() => {
		if (!showUnreadMessages) {
			return;
		}
		const content = contentRef.current;
		if (!content) {
			return;
		}

		syncUnreadMessages();
		const observer =
			globalThis.MutationObserver === undefined
				? null
				: new MutationObserver(syncUnreadMessages);
		observer?.observe(content, { childList: true, subtree: true });
		return () => observer?.disconnect();
	}, [showUnreadMessages, syncUnreadMessages]);

	useEffect(() => {
		if (!showUnreadMessages) {
			return;
		}
		const content = contentRef.current;
		if (!content) {
			return;
		}

		for (const node of Array.from(content.children)) {
			if (!(node instanceof HTMLElement)) {
				continue;
			}
			delete node.dataset.unreadStart;
			delete node.dataset.unreadLabel;
		}

		if (!unreadStartId || newMessageCount === 0) {
			return;
		}

		const unreadStart = Array.from(content.children).find(
			(node): node is HTMLElement =>
				node instanceof HTMLElement && node.dataset.messageId === unreadStartId
		);
		if (unreadStart) {
			unreadStart.dataset.unreadStart = "true";
			unreadStart.dataset.unreadLabel = `${newMessageCount} new messages`;
		}
	}, [newMessageCount, showUnreadMessages, unreadStartId]);

	useEffect(() => {
		const content = contentRef.current;
		if (!content || globalThis.ResizeObserver === undefined) {
			return;
		}

		const observer = new ResizeObserver(() => {
			scheduleRailSync();
			if (!(followOutput && followingRef.current)) {
				return;
			}
			scrollToEnd(reduce || !smooth ? "auto" : "smooth");
		});
		observer.observe(content);

		return () => observer.disconnect();
	}, [followOutput, reduce, scheduleRailSync, scrollToEnd, smooth]);

	useEffect(() => {
		if (navigation !== "rail") {
			railTargetsRef.current.clear();
			setRailItems([]);
			setRailOverflowing(false);
			return;
		}

		const content = contentRef.current;
		const viewport = viewportRef.current;
		if (!(content && viewport)) {
			return;
		}

		scheduleRailSync();
		const mutationObserver =
			globalThis.MutationObserver === undefined
				? null
				: new MutationObserver(scheduleRailSync);
		mutationObserver?.observe(content, {
			childList: true,
			characterData: true,
			subtree: true,
		});

		const resizeObserver =
			globalThis.ResizeObserver === undefined
				? null
				: new ResizeObserver(scheduleRailSync);
		resizeObserver?.observe(content);
		resizeObserver?.observe(viewport);

		return () => {
			mutationObserver?.disconnect();
			resizeObserver?.disconnect();
		};
	}, [navigation, scheduleRailSync]);

	useEffect(
		() => () => {
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
			if (railFrameRef.current) {
				cancelAnimationFrame(railFrameRef.current);
			}
		},
		[]
	);

	const scrollToRailItem = useCallback(
		(item: PreviewRailItem) => {
			const viewport = viewportRef.current;
			const target = railTargetsRef.current.get(item.id);
			if (!(viewport && target)) {
				return;
			}

			const lastItem = railItems.at(-1)?.id === item.id;
			setActiveRailId(item.id);
			if (lastItem) {
				setFollowing(true);
				scrollToEnd(reduce || !smooth ? "auto" : "smooth");
				return;
			}

			setFollowing(false);
			programmaticScrollRef.current = true;
			const behavior = reduce || !smooth ? "auto" : "smooth";

			if (isNativeFunction(target.scrollIntoView)) {
				target.scrollIntoView({ behavior, block: "center", inline: "nearest" });
			} else if (isNativeFunction(viewport.scrollTo)) {
				const viewportRect = viewport.getBoundingClientRect();
				const targetRect = target.getBoundingClientRect();
				const top =
					viewport.scrollTop +
					targetRect.top -
					viewportRect.top -
					(viewport.clientHeight - targetRect.height) / 2;
				viewport.scrollTo({ top, behavior });
			} else {
				const viewportRect = viewport.getBoundingClientRect();
				const targetRect = target.getBoundingClientRect();
				viewport.scrollTop =
					viewport.scrollTop +
					targetRect.top -
					viewportRect.top -
					(viewport.clientHeight - targetRect.height) / 2;
			}
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			scrollTimerRef.current = window.setTimeout(
				() => {
					programmaticScrollRef.current = false;
				},
				behavior === "smooth" ? 320 : 0
			);
		},
		[railItems, reduce, scrollToEnd, setFollowing, smooth]
	);

	const viewport = (
		<section
			aria-label={label}
			className={cn(
				"scroll-fade h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				navigation === "rail"
					? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					: "[scrollbar-gutter:stable]",
				viewportClassName
			)}
			{...restViewportProps}
			onKeyDown={(event) => {
				if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
					leaveLiveEdge();
				}
				onViewportKeyDown?.(event);
			}}
			onScroll={(event) => {
				handleScroll();
				onViewportScroll?.(event);
			}}
			onTouchStart={(event) => {
				leaveLiveEdge();
				onViewportTouchStart?.(event);
			}}
			onWheel={(event) => {
				leaveLiveEdge();
				onViewportWheel?.(event);
			}}
			ref={setViewportRef}
		>
			<div
				aria-busy={busy}
				aria-live="polite"
				aria-relevant="additions text"
				className={
					contentInset === "default" && contentSpacing === "default"
						? contentClassName
						: cn(
								contentSpacing === "flush" && "gap-0",
								contentInset === "compact" && "px-0.5 py-1",
								contentInset === "transcript" && "px-3 py-6",
								contentClassName
							)
				}
				ref={contentRef}
				role="log"
				{...contentProps}
			>
				{children}
			</div>
		</section>
	);

	return (
		<div
			className={cn("relative min-h-0", className)}
			data-slot="message-scroller"
			{...props}
		>
			{navigation === "rail" ? (
				<PreviewRail
					activeId={activeRailId}
					className="h-full min-h-0 overflow-hidden"
					highlightActive
					itemSize={14}
					items={railCollapsed ? [] : railOverflowing ? railItems : []}
					label={navigationLabel}
					onItemSelect={scrollToRailItem}
					previewClassName={
						renderPreview
							? "ml-1 w-72 max-w-full"
							: "ml-1 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4"
					}
					previewContainerClassName="right-3 left-8"
					previewSide="after"
					railClassName={cn(
						"absolute inset-y-3 left-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-left",
						railOverflowing
							? "pointer-events-auto opacity-100"
							: "pointer-events-none opacity-0",
						railClassName
					)}
					renderPreview={renderPreview}
					showPreview={!railCollapsed}
				>
					{viewport}
					{railCollapsed ? (
						<CollapsedMessageRail
							activeId={activeRailId}
							items={railItems}
							onItemSelect={scrollToRailItem}
						/>
					) : null}
				</PreviewRail>
			) : (
				viewport
			)}
			{showScrollToLatest && !following ? (
				<Button
					aria-label={
						newMessageCount > 0
							? `${newMessageCount} new messages. Scroll to latest`
							: "Scroll to latest message"
					}
					className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 gap-1.5 rounded-full border border-primary/30 bg-background/95 px-3 shadow-lg backdrop-blur-md"
					data-new-message-count={newMessageCount}
					data-slot="message-scroll-to-bottom"
					onClick={() => scrollToEnd(reduce || !smooth ? "auto" : "smooth")}
					size="sm"
					variant="secondary"
				>
					<HugeiconsIcon icon={ArrowDown02Icon} size={15} strokeWidth={2} />
					<span>
						{newMessageCount > 0
							? `${newMessageCount > 99 ? "99+" : newMessageCount} new messages`
							: "Latest messages"}
					</span>
				</Button>
			) : null}
		</div>
	);
}
