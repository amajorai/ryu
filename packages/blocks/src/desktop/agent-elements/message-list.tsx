import {
	ArrowDown02Icon,
	InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { MessageScroller as BeuiMessageScroller } from "@ryu/ui/components/agents/message-scroller";
import { Button } from "@ryu/ui/components/button";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import { Loader } from "@ryu/ui/components/motion/loader";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";
import { ChatRailPreview, OpenAtBottom } from "./chat-rail-preview.tsx";
import { FloatingDateHeader } from "./floating-date-header.tsx";
import { useMessageListFollow } from "./message-list-follow.ts";
import type { MessageListScope } from "./message-list-scope.ts";
import { useMessageListTurns } from "./message-list-turns.tsx";
import type { MessageListProps } from "./message-list-types.ts";
import { PinnedUserMessageBar } from "./pinned-user-message-bar.tsx";
import { SelectionQuoteToolbar } from "./quote.tsx";
import { DEFAULT_STATS_PLUGIN_ENABLED } from "./stats-model.ts";
import { renderTranscriptTurns } from "./transcript-turn.tsx";
import { nativeSdkCallable } from "./utils/native-dom-observations.ts";

export type {
	ImageGenerationPartData,
	VideoGenerationPartData,
} from "./assistant-generated-media.tsx";
export type { MessageListProps } from "./message-list-types.ts";

export const MessageList = memo(function MessageList({
	showCopyToolbar = true,
	suppressQuestionTool = false,
	initialScrollBehavior = "bottom",
	enableImagePreview = true,
	statsPluginEnabled = DEFAULT_STATS_PLUGIN_ENABLED,
	...props
}: MessageListProps) {
	const tl = useLiteralMessages();
	// Each hook reads only bindings that earlier hooks already assigned.
	const scope = {
		...props,
		showCopyToolbar,
		suppressQuestionTool,
		initialScrollBehavior,
		enableImagePreview,
		statsPluginEnabled,
	} as MessageListScope;
	Object.assign(scope, useMessageListFollow(scope));
	Object.assign(scope, useMessageListTurns(scope));
	const {
		scrollerRef,
		normalizedMessages,
		openAtBottom,
		isStreaming,
		isCompact,
		followOutput,
		handleFollowChange,
		railItems,
		ownScrollerRootClasses,
		clearUnreadBoundaryPreservation,
		handleViewportScroll,
		viewportRef,
		pinUserMessage,
		isScrollingUp,
		pinnedMessage,
		scrollToPinned,
		following,
		unreadMessageCount,
		unreadMessageLabel,
		preserveUnreadBoundaryRef,
		setScrollDirection,
		dividersKey,
		startOfToday,
		conversationKey,
		hasOlderMessages,
		loadingOlderMessages,
		historyNotices,
		historyNotice,
		onQuote,
		selectionActions,
		onContributedSelectionAction,
	} = scope;
	return (
		<div className="relative flex min-h-0 flex-1 flex-col" ref={scrollerRef}>
			{/* A surface that deliberately reads top-down (a static transcript)
			    opts out via `initialScrollBehavior="top"`; the user opts out via
			    Appearance → "Open chats at the latest message". */}
			<OpenAtBottom
				containerRef={scrollerRef}
				conversationKey={conversationKey ?? normalizedMessages[0]?.id ?? null}
				enabled={openAtBottom && initialScrollBehavior !== "top"}
				hasMessages={normalizedMessages.length > 0}
			/>
			{/* beUI MessageScroller: self-contained follow-at-the-live-edge viewport.
			    `data-slot` props below preserve the transcript DOM contract the
			    pinned-message bar and the e2e scroll/grouping/date specs read. The
			    turn rows render as plain `message-scroller-item` children (beUI
			    has no item primitive), with the same `data-group-position` the
			    sender-run styling keys off.
			    `followOutput` is gated by the SAME pref `OpenAtBottom` reads: with
			    "Open chats at the latest message" off, a transcript that hydrated
			    hidden must stay where it loaded once revealed — the beUI scroller's
			    ResizeObserver would otherwise re-follow the reveal resize and yank
			    it to the bottom (chat-scroll-story.spec.ts asserts this). */}
			<BeuiMessageScroller
				busy={isStreaming}
				className="flex-1"
				contentClassName={cn(
					"w-full",
					isCompact
						? undefined
						: "mx-auto max-w-[calc(var(--an-max-width,880px)_+_var(--spacing)*6)]"
				)}
				contentInset={isCompact ? "compact" : "transcript"}
				contentProps={{ "data-slot": "message-scroller-content" }}
				contentSpacing="flush"
				followOutput={followOutput}
				label="Conversation"
				navigation="rail"
				onFollowChange={handleFollowChange}
				railItems={railItems}
				ref={ownScrollerRootClasses}
				renderPreview={(item) => <ChatRailPreview item={item} />}
				showScrollToLatest={false}
				showUnreadMessages={false}
				smooth
				viewportProps={{
					"data-slot": "message-scroller-viewport",
					onKeyDown: (event) => {
						if (["ArrowDown", "End", "PageDown"].includes(event.key)) {
							clearUnreadBoundaryPreservation();
						}
					},
					onScroll: handleViewportScroll,
					onTouchStart: clearUnreadBoundaryPreservation,
					onWheel: clearUnreadBoundaryPreservation,
				}}
				viewportRef={viewportRef}
			>
				{hasOlderMessages ? (
					<div
						aria-busy={loadingOlderMessages}
						aria-live="polite"
						className="mx-auto w-full max-w-[calc(var(--an-max-width,880px)_+_var(--spacing)*6)] px-3 py-2 text-center text-muted-foreground text-xs"
						data-older-messages-loader
					>
						{loadingOlderMessages
							? "Loading older messages…"
							: "Scroll up for older messages"}
					</div>
				) : null}
				{pinUserMessage && !isCompact && isScrollingUp && pinnedMessage ? (
					// `data-slot` is load-bearing: the pin bar sits IN FLOW, so
					// mounting it pushes every anchor below it down by its own
					// height. usePinnedUserMessage measures this element to size the
					// release hysteresis that stops the bar un-electing its own
					// anchor (see PIN_RELEASE_SLACK).
					//
					// `top-9` reserves the fixed date-chip lane above the bar. The
					// bar remains in flow so its measured height continues to drive
					// pin-election hysteresis without moving the floating chip.
					//
					// It MUST be a sticky top offset and NOT padding — an offset
					// only moves where the bar paints, whereas padding would change
					// its offsetHeight, which is the very number PINNED_BAR_SLOT /
					// PIN_RELEASE_SLACK measure.
					<div
						className="sticky top-9 z-20 -mb-1"
						data-slot="pinned-user-message-bar"
					>
						<div className="mx-auto w-full max-w-[calc(var(--an-max-width,880px)_+_var(--spacing)*6)] px-3 pt-2 pb-1">
							<PinnedUserMessageBar
								message={pinnedMessage}
								onScrollTo={scrollToPinned}
							/>
						</div>
					</div>
				) : null}
				{/* The selected width describes content, excluding the transcript's
                    two px-3 gutters. The fallback preserves hosts that do not
                    bootstrap desktop appearance preferences. */}
				{/* `gap-0`, NOT the `gap-2` this used to carry. A uniform gap can
				    only express one vertical rhythm, and messaging grouping needs
				    two: ~2px between consecutive messages from the same speaker
				    and 8px everywhere else. A run spans SIBLING children here (see
				    `userRunPositions`), so the tightening cannot live on a wrapper
				    — every direct child brings its own explicit top margin
				    instead, keyed off `data-group-position`. Negative margins are
				    deliberately not used: they would fight the scroller's
				    intrinsic-size estimates. */}
				{renderTranscriptTurns(scope)}
				{[
					...(historyNotices ?? []),
					...(historyNotice ? [historyNotice] : []),
				].map((notice) => (
					// A thread-level notice, not a turn-level one, so it is the LAST
					// direct child of Content rather than part of any message. No
					// `messageId` and no scroll anchor, so it can never become the
					// scroll target and steal the jump from the user's next question —
					// the same rule the date separators follow.
					<Marker
						className="mt-2 shrink-0"
						key={notice.id}
						spacing="turn"
						variant="separator"
					>
						<MarkerIcon>
							<HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
						</MarkerIcon>
						<MarkerContent>
							<span className="font-medium">{notice.title}</span>
							{notice.description ? <span> {notice.description}</span> : null}
						</MarkerContent>
						{notice.actions?.map((action) => (
							<button
								className="shrink-0 underline underline-offset-3 hover:text-foreground"
								key={action.label}
								onClick={action.onClick}
								type="button"
							>
								{action.label}
							</button>
						))}
					</Marker>
				))}
			</BeuiMessageScroller>
			{/* The scrolled-up escape hatch: beUI keeps following output only while
			    the reader stays at the live edge, so once they scroll up there is no
			    built-in way back down. A compact end button appears in that state
			    and returns to the newest message. `onFollowChange` drives it. */}
			{isCompact || following ? null : (
				<Button
					appearance="transcript-follow"
					aria-label={
						unreadMessageCount > 0
							? tl("Scroll to latest, {label}", { label: unreadMessageLabel })
							: tl("Scroll to latest")
					}
					className={cn(
						"absolute bottom-3 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center justify-center",
						unreadMessageCount > 0 ? "max-w-[calc(100%-1.5rem)]" : undefined
					)}
					onClick={() => {
						preserveUnreadBoundaryRef.current = false;
						setScrollDirection("down");
						const viewport = viewportRef.current;
						if (!viewport) {
							return;
						}
						if (nativeSdkCallable(viewport.scrollTo)) {
							viewport.scrollTo({
								top: viewport.scrollHeight,
								behavior: "smooth",
							});
						} else {
							viewport.scrollTop = viewport.scrollHeight;
						}
					}}
					size={
						unreadMessageCount > 0
							? "transcript-follow-unread"
							: "transcript-follow-icon"
					}
					type="button"
					variant="ghost"
				>
					{isStreaming ? (
						<Loader
							label="Agent is active"
							size={16}
							speed={0.8}
							variant="dots"
						/>
					) : (
						<HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} />
					)}
					{unreadMessageCount > 0 ? (
						<span className="truncate text-xs tabular-nums">
							{unreadMessageLabel}
						</span>
					) : (
						<span className="sr-only">Scroll to latest</span>
					)}
				</Button>
			)}
			{/* FloatingDateHeader is OUT OF FLOW BY CONSTRUCTION — it absolutely
			    positions against this relative root, exactly where it used to sit
			    inside the shadcn scroller's own root. Keeping it out of flow means
			    mounting it can never move a scroll anchor, which is the same
			    guarantee the pinned-user-message bar's design depends on. (The old
			    left-gutter ChatToc is gone — the beUI rail navigation replaced it,
			    with the same info rendered in its preview cards.) */}
			{isCompact ? null : (
				<FloatingDateHeader
					atRest={following}
					dividersKey={dividersKey}
					startOfToday={startOfToday}
					viewportRef={viewportRef}
				/>
			)}
			{(onQuote || selectionActions?.length) && (
				<SelectionQuoteToolbar
					containerRef={scrollerRef}
					onContributedAction={onContributedSelectionAction}
					onQuote={onQuote}
					selectionActions={selectionActions}
				/>
			)}
		</div>
	);
});
