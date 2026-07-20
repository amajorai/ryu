"use client";

import { cn } from "@ryu/ui/lib/utils";
import { IconQuote, IconX } from "@tabler/icons-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { SELECTABLE_ATTR } from "./quote-format.ts";

/**
 * Chat message quoting (ChatGPT / assistant-ui style). Selecting text inside a
 * message surfaces a floating "Quote" button; clicking it stashes the selection
 * as a pending quote shown above the composer, and the sent user bubble
 * re-renders that quote as an inline block.
 *
 * The quote is persisted by prefixing the outgoing message with a markdown `>`
 * blockquote (see `formatQuotePrefix`) — so the model receives the quoted
 * context, the quote survives a reload, and no message-metadata plumbing is
 * needed. `splitLeadingQuote` peels that prefix back off for display. Those pure
 * helpers live in `./quote-format.ts` and are re-exported here for consumers.
 */

export {
	formatQuotePrefix,
	messageSelectableProps,
	splitLeadingQuote,
} from "./quote-format.ts";

const SELECTABLE_SELECTOR = `[${SELECTABLE_ATTR}]`;

function closestSelectable(node: Node | null): HTMLElement | null {
	let el: Node | null = node;
	while (el && el.nodeType !== Node.ELEMENT_NODE) {
		el = el.parentNode;
	}
	return (el as HTMLElement | null)?.closest(SELECTABLE_SELECTOR) ?? null;
}

interface SelectionQuoteToolbarProps {
	className?: string;
	/** Only react to selections inside this scroll container (avoids bleed across
	 * split-view chats). Omit to accept any `[data-message-selectable]`. */
	containerRef?: RefObject<HTMLElement | null>;
	/** Called with the selected plain text when the user clicks "Quote". */
	onQuote?: (text: string) => void;
}

/**
 * Floating toolbar that appears above a text selection made inside a message.
 * Portals to `document.body` and is positioned from the selection's client
 * rect. Hides on collapse, scroll, or when the selection leaves message text.
 */
export function SelectionQuoteToolbar({
	containerRef,
	onQuote,
	className,
}: SelectionQuoteToolbarProps) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
		null
	);
	const textRef = useRef("");

	const hide = useCallback(() => {
		setAnchor(null);
		textRef.current = "";
	}, []);

	const update = useCallback(() => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			hide();
			return;
		}
		const text = selection.toString().trim();
		if (!text) {
			hide();
			return;
		}
		const anchorEl = closestSelectable(selection.anchorNode);
		const focusEl = closestSelectable(selection.focusNode);
		if (!(anchorEl && focusEl)) {
			hide();
			return;
		}
		if (containerRef?.current && !containerRef.current.contains(anchorEl)) {
			hide();
			return;
		}
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			hide();
			return;
		}
		textRef.current = text;
		setAnchor({ top: rect.top, left: rect.left + rect.width / 2 });
	}, [containerRef, hide]);

	useEffect(() => {
		// mouseup/keyup finalize a selection; rAF lets it settle before we read it.
		const onSettle = () => requestAnimationFrame(update);
		const onSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) {
				hide();
			}
		};
		document.addEventListener("mouseup", onSettle);
		document.addEventListener("keyup", onSettle);
		document.addEventListener("selectionchange", onSelectionChange);
		// The selection rect is viewport-relative; a scroll moves it, so dismiss.
		window.addEventListener("scroll", hide, true);
		return () => {
			document.removeEventListener("mouseup", onSettle);
			document.removeEventListener("keyup", onSettle);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("scroll", hide, true);
		};
	}, [update, hide]);

	if (!anchor) {
		return null;
	}

	return createPortal(
		<div
			className={cn(
				"fixed z-[60] -translate-x-1/2 -translate-y-full pb-1.5",
				className
			)}
			// Keep the underlying selection alive when the button is pressed.
			onMouseDown={(event) => event.preventDefault()}
			style={{ top: anchor.top, left: anchor.left }}
		>
			<button
				className="flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 font-medium text-popover-foreground text-xs shadow-md transition-colors hover:bg-accent hover:text-accent-foreground"
				onClick={() => {
					const text = textRef.current;
					if (text) {
						onQuote?.(text);
					}
					window.getSelection()?.removeAllRanges();
					hide();
				}}
				type="button"
			>
				<IconQuote className="size-3.5" />
				Quote
			</button>
		</div>,
		document.body
	);
}

interface ComposerQuotePreviewProps {
	className?: string;
	/** Clear the pending quote. */
	onDismiss?: () => void;
	/** The pending quote text. */
	text: string;
}

/**
 * The pending quote shown inside the composer, above the textarea. Renders only
 * when a quote is set; a dismiss button clears it.
 */
export function ComposerQuotePreview({
	text,
	onDismiss,
	className,
}: ComposerQuotePreviewProps) {
	return (
		<div
			className={cn(
				"mx-2.5 mt-2.5 flex items-start gap-2 rounded-md border-primary/50 border-l-2 bg-foreground/5 py-1.5 pr-1.5 pl-2.5",
				className
			)}
		>
			<IconQuote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
			<p className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-[13px] text-muted-foreground leading-snug">
				{text}
			</p>
			{onDismiss && (
				<button
					aria-label="Remove quote"
					className="shrink-0 rounded-md p-0.5 text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
					onClick={onDismiss}
					type="button"
				>
					<IconX className="size-3.5" />
				</button>
			)}
		</div>
	);
}

interface QuoteBlockProps {
	className?: string;
	/** The quoted text to display. */
	text: string;
}

/**
 * Inline quote display shown above a sent user message's own text. Rendered by
 * the user bubble when {@link splitLeadingQuote} finds a leading blockquote.
 */
export function QuoteBlock({ text, className }: QuoteBlockProps) {
	return (
		<p
			className={cn(
				"mb-1.5 line-clamp-4 whitespace-pre-wrap border-foreground/25 border-l-2 pl-2 text-[13px] text-muted-foreground leading-snug",
				className
			)}
		>
			{text}
		</p>
	);
}
