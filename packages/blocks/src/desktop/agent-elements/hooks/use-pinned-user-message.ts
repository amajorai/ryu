import type { UIMessage } from "ai";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

function getUserMessageText(message: UIMessage): string {
	return (message.parts ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
		)
		.map((part) => part.text)
		.join("");
}

/**
 * Tracks which user message should appear in the sticky pin bar while scrolling
 * through a long assistant reply (Cursor-style). Returns the message to pin when
 * its bubble has scrolled above the viewport top; clears when it scrolls back
 * into view or when a newer turn's user message takes over.
 */
export function usePinnedUserMessage({
	enabled,
	messages,
	scrollerRef,
	pinThreshold = 12,
}: {
	enabled: boolean;
	messages: UIMessage[];
	scrollerRef: RefObject<HTMLElement | null>;
	pinThreshold?: number;
}) {
	const [pinnedId, setPinnedId] = useState<string | null>(null);
	const anchorRefs = useRef(new Map<string, HTMLElement>());

	const registerAnchor = useCallback(
		(messageId: string, el: HTMLElement | null) => {
			if (el) {
				anchorRefs.current.set(messageId, el);
			} else {
				anchorRefs.current.delete(messageId);
			}
		},
		[]
	);

	const userMessages = useMemo(
		() => messages.filter((m) => m.role === "user"),
		[messages]
	);

	const pinnedMessage = useMemo(
		() => userMessages.find((m) => m.id === pinnedId) ?? null,
		[userMessages, pinnedId]
	);

	const getViewport = useCallback(() => {
		return (
			scrollerRef.current?.querySelector<HTMLElement>(
				'[data-slot="message-scroller-viewport"]'
			) ?? null
		);
	}, [scrollerRef]);

	useEffect(() => {
		if (!enabled) {
			setPinnedId(null);
			return;
		}

		const viewport = getViewport();
		if (!viewport) {
			return;
		}

		const update = () => {
			const viewportTop = viewport.getBoundingClientRect().top + pinThreshold;
			let candidate: string | null = null;

			for (const msg of userMessages) {
				const el = anchorRefs.current.get(msg.id);
				if (!el) {
					continue;
				}
				const text = getUserMessageText(msg);
				const hasParts = (msg.parts ?? []).length > 0;
				if (!(text || hasParts)) {
					continue;
				}
				if (el.getBoundingClientRect().bottom < viewportTop) {
					candidate = msg.id;
				}
			}

			setPinnedId((prev) => (prev === candidate ? prev : candidate));
		};

		update();
		viewport.addEventListener("scroll", update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(viewport);

		return () => {
			viewport.removeEventListener("scroll", update);
			ro.disconnect();
		};
	}, [enabled, userMessages, getViewport, pinThreshold]);

	const scrollToPinned = useCallback(() => {
		if (!pinnedId) {
			return;
		}
		const el = anchorRefs.current.get(pinnedId);
		el?.scrollIntoView({ behavior: "smooth", block: "start" });
	}, [pinnedId]);

	return { pinnedMessage, registerAnchor, scrollToPinned };
}
