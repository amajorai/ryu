import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail.tsx";
import type { ComponentPropsWithRef, ReactNode, Ref } from "react";

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
