import type { useMessageScrollerFollow } from "./message-scroller-follow.ts";
import type { MessageScrollerProps } from "./message-scroller-props.ts";
import type { useMessageScrollerRail } from "./message-scroller-rail-sync.ts";
import type { useMessageScrollerViewport } from "./message-scroller-viewport.tsx";

/** The props after MessageScroller's parameter defaults are applied. */
export type MessageScrollerBaseScope = Omit<
	MessageScrollerProps,
	| "followOutput"
	| "followThreshold"
	| "smooth"
	| "showScrollToLatest"
	| "showUnreadMessages"
	| "label"
	| "navigationLabel"
	| "contentInset"
	| "contentSpacing"
> &
	Required<
		Pick<
			MessageScrollerProps,
			| "followOutput"
			| "followThreshold"
			| "smooth"
			| "showScrollToLatest"
			| "showUnreadMessages"
			| "label"
			| "navigationLabel"
			| "contentInset"
			| "contentSpacing"
		>
	> & {
		props: Omit<
			MessageScrollerProps,
			| "followOutput"
			| "followThreshold"
			| "smooth"
			| "onFollowChange"
			| "showScrollToLatest"
			| "showUnreadMessages"
			| "label"
			| "busy"
			| "navigation"
			| "railItems"
			| "renderPreview"
			| "navigationLabel"
			| "viewportClassName"
			| "contentClassName"
			| "contentInset"
			| "contentSpacing"
			| "railClassName"
			| "viewportRef"
			| "viewportProps"
			| "contentProps"
			| "className"
			| "children"
		>;
	};

/** Every binding MessageScroller computes, in render order. */
export type MessageScrollerScope = MessageScrollerBaseScope &
	ReturnType<typeof useMessageScrollerRail> &
	ReturnType<typeof useMessageScrollerFollow> &
	ReturnType<typeof useMessageScrollerViewport>;
