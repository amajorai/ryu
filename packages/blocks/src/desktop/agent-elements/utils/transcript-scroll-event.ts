/** Native window event published by ChatPage, TabsContext and AppSidebar.
 * This declares their real CustomEvent detail contract; it adds no parser,
 * wrapper, registration or runtime admission to the existing event path. */
export type TranscriptScrollEvent = CustomEvent<{ messageId?: string }>;
declare global {
	interface WindowEventMap {
		"ryu:scroll-to-message": TranscriptScrollEvent;
	}
}
