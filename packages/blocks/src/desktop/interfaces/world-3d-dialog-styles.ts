import type { ThreadStatus } from "@ryuhq/protocol/interfaces";

/** Panel width when a conversation is open; the interface shifts the view by it. */
export const THREAD_PANEL_WIDTH = "clamp(360px, 46vw, 680px)";

/**
 * A choice row, inset from the list's edges so its radius sits inside the
 * panel's; hover and keyboard focus both fill it, as menu items do.
 */
export const ROW =
	"mx-1 flex h-10 w-[calc(100%-0.5rem)] items-center gap-3 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

/** Only what asks for the user is colored; the rest reads as metadata. */
export const STATUS_TEXT: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-muted-foreground",
	"your-turn": "text-primary",
};
