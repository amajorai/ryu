import { useLiteralMessages } from "@ryu/i18n/react";
import { motion } from "motion/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useRef,
} from "react";
import { ConversationHeader } from "./desk-conversation-header.tsx";
import type { DeskRow } from "./desk-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

export type { DeskNeedsYouHint } from "./desk-conversation-no-selection.tsx";
export { DeskNoSelection } from "./desk-conversation-no-selection.tsx";

/** True for targets where Escape belongs to the text the user is editing. */
function isEditableTarget(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

/**
 * The open conversation: our header over the host's real chat screen, with
 * the details sidebar beside it (or over it at narrow widths).
 */
export function DeskConversation({
	details,
	detailsOpen,
	detailsOverlay,
	newTargetLabel,
	onClose,
	onCloseDetails,
	onToggleDetails,
	ref,
	row,
	stacked,
	threadView,
}: {
	/** The details sidebar, when it is open and there is a thread to describe. */
	details: ReactNode | null;
	detailsOpen: boolean;
	/** Float details over the chat instead of beside it. */
	detailsOverlay: boolean;
	newTargetLabel: string | null;
	onClose: () => void;
	onCloseDetails: () => void;
	onToggleDetails: (() => void) | null;
	ref?: Ref<HTMLElement>;
	/** Null while the host shows a brand-new conversation. */
	row: DeskRow | null;
	stacked: boolean;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const mainRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const focusInOverlay = useRef(false);
	const overlayOpen = Boolean(details) && detailsOverlay;
	const reduceMotion = useReducedMotion();
	const transition = reduceMotion
		? { duration: 0 }
		: { duration: 0.18, ease: "easeOut" as const };
	const wasDetailsOpen = useRef(detailsOpen);

	// Floating details take focus when the user opens them, and hand it back
	// to the Details toggle when they close with focus inside them.
	useEffect(() => {
		const opened = detailsOpen && !wasDetailsOpen.current;
		wasDetailsOpen.current = detailsOpen;
		if (overlayOpen) {
			if (opened) {
				overlayRef.current
					?.querySelector<HTMLElement>("#desk-details")
					?.focus({ preventScroll: true });
			}
			return;
		}
		if (!focusInOverlay.current) {
			return;
		}
		focusInOverlay.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) {
			mainRef.current
				?.querySelector<HTMLElement>("[data-testid='desk-details-toggle']")
				?.focus({ preventScroll: true });
		}
	}, [detailsOpen, overlayOpen]);

	const onOverlayBlur = (event: FocusEvent<HTMLDivElement>) => {
		// A null relatedTarget is focus lost to removal: keep the flag so the
		// effect above can return focus to the toggle.
		const next = event.relatedTarget;
		if (next instanceof Node && !event.currentTarget.contains(next)) {
			focusInOverlay.current = false;
		}
	};

	// Esc closes the details overlay first, then the conversation, unless the
	// host's chat already used it or the user is typing a reply.
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			isEditableTarget(event.target)
		) {
			return;
		}
		event.preventDefault();
		if (overlayOpen) {
			onCloseDetails();
			return;
		}
		onClose();
	};
	return (
		<section
			aria-label={
				row
					? tl("Conversation: {title}", { title: row.title })
					: "New conversation"
			}
			className="@container/conv relative flex min-h-0 min-w-0 flex-1 outline-none"
			data-testid="desk-conversation"
			onKeyDown={onKeyDown}
			ref={ref}
			tabIndex={-1}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col" ref={mainRef}>
				<ConversationHeader
					detailsInline={Boolean(details) && !detailsOverlay}
					detailsOpen={detailsOpen}
					newTargetLabel={newTargetLabel}
					onClose={onClose}
					onToggleDetails={onToggleDetails}
					row={row}
					stacked={stacked}
				/>
				<div
					className="min-h-0 flex-1 overflow-hidden"
					data-testid="desk-thread-view"
				>
					{threadView}
				</div>
			</div>
			{overlayOpen ? (
				<motion.div
					animate={{ opacity: 1, x: 0 }}
					className="absolute top-14 right-0 bottom-0 z-20 flex max-w-full shadow-lg"
					initial={reduceMotion ? false : { opacity: 0, x: 16 }}
					onBlur={onOverlayBlur}
					onFocus={() => {
						focusInOverlay.current = true;
					}}
					ref={overlayRef}
					transition={transition}
				>
					{details}
				</motion.div>
			) : null}
			{details && !detailsOverlay ? (
				<motion.div
					animate={{ width: 300 }}
					className="flex shrink-0 overflow-hidden"
					initial={reduceMotion ? false : { width: 0 }}
					transition={transition}
				>
					{details}
				</motion.div>
			) : null}
		</section>
	);
}
