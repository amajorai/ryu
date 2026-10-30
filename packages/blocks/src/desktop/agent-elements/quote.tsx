"use client";

import { Cancel01Icon, QuoteDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { cn } from "@ryu/ui/lib/utils";
import {
	Fragment,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import { SELECTABLE_ATTR } from "./quote-format.ts";
import type {
	ContributedSelectionAction,
	SelectionActionContext,
} from "./types.ts";

/**
 * Chat message quoting (ChatGPT / assistant-ui style). Selecting text inside a
 * message surfaces a floating annotate box with a "Quote" action; quoting stashes
 * the selection as a pending quote shown above the composer, and the sent user bubble
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

function isElementNode(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

function closestSelectable(node: Node | null): Element | null {
	let el: Node | null = node;
	while (el && !isElementNode(el)) {
		el = el.parentNode;
	}
	return el?.closest(SELECTABLE_SELECTOR) ?? null;
}

interface SelectionQuoteToolbarProps {
	className?: string;
	/** Only react to selections inside this scroll container (avoids bleed across
	 * split-view chats). Omit to accept any `[data-message-selectable]`. */
	containerRef?: RefObject<HTMLElement | null>;
	/** Dispatches a contributed action with the selected plain text and the note
	 * typed into the popover (if any). */
	onContributedAction?: (
		action: ContributedSelectionAction,
		context: SelectionActionContext
	) => void;
	/** Called with the selected plain text (and the typed note, if any) when the
	 * user clicks "Quote" or presses Enter in the note box. */
	onQuote?: (text: string, note?: string) => void;
	/** Declarative actions supplied by the host from enabled plugins. */
	selectionActions?: readonly ContributedSelectionAction[];
}

interface SelectionDraft {
	/** Prefer the space above the selection; flip below near the viewport top. */
	placement: "above" | "below";
	range: Range;
	text: string;
	x: number;
	y: number;
}

/** CSS Custom Highlight name that keeps the selection visible once focus moves
 * into the note box (focusing a textarea clears the document selection). */
const SELECTION_HIGHLIGHT = "ryu-message-selection";
const POPOVER_WIDTH = 320;
const POPOVER_FLIP_THRESHOLD = 160;
const VIEWPORT_GUTTER = 8;

interface HighlightRegistryLike {
	delete: (name: string) => boolean;
	set: (name: string, highlight: unknown) => void;
}

function highlightRegistry(): HighlightRegistryLike | null {
	if (typeof CSS === "undefined" || typeof Highlight === "undefined") {
		return null;
	}
	return (
		(CSS as unknown as { highlights?: HighlightRegistryLike }).highlights ??
		null
	);
}

function placeDraft(range: Range, text: string): SelectionDraft | null {
	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) {
		return null;
	}
	const half = POPOVER_WIDTH / 2 + VIEWPORT_GUTTER;
	const center = rect.left + rect.width / 2;
	const x = Math.min(
		Math.max(center, half),
		Math.max(half, window.innerWidth - half)
	);
	const placement = rect.top < POPOVER_FLIP_THRESHOLD ? "below" : "above";
	return {
		placement,
		range,
		text,
		x,
		y: placement === "above" ? rect.top - 6 : rect.bottom + 6,
	};
}

/**
 * Annotate popover that appears as soon as text inside a message is selected —
 * the same mini note box the other annotation surfaces use, so writing comes
 * first and choosing what to do with it comes second. The box is optional:
 * every action (Quote, Ask in side chat, Explain, …) runs on the selection and
 * forwards whatever was typed, so an empty box behaves like the old one-click
 * toolbar.
 *
 * Portals to `document.body` and is positioned from the selection's client
 * rect. Dismisses on Escape, an outside press, or once an action runs.
 */
export function SelectionQuoteToolbar({
	containerRef,
	onQuote,
	className,
	selectionActions,
	onContributedAction,
}: SelectionQuoteToolbarProps) {
	const [draft, setDraft] = useState<SelectionDraft | null>(null);
	const [note, setNote] = useState("");
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const noteRef = useRef<HTMLTextAreaElement | null>(null);
	const focusNoteRef = useRef(false);
	const noteId = useId();
	const draftTextRef = useRef("");

	const hide = useCallback(() => {
		draftTextRef.current = "";
		setDraft(null);
		setNote("");
		highlightRegistry()?.delete(SELECTION_HIGHLIGHT);
	}, []);

	const update = useCallback(
		(focusNote: boolean) => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				return;
			}
			const text = selection.toString().trim();
			if (!text) {
				return;
			}
			const anchorEl = closestSelectable(selection.anchorNode);
			const focusEl = closestSelectable(selection.focusNode);
			if (!(anchorEl && focusEl)) {
				return;
			}
			if (containerRef?.current && !containerRef.current.contains(anchorEl)) {
				return;
			}
			const range = selection.getRangeAt(0).cloneRange();
			const next = placeDraft(range, text);
			if (!next) {
				return;
			}
			const registry = highlightRegistry();
			if (registry) {
				registry.set(SELECTION_HIGHLIGHT, new Highlight(range));
			}
			focusNoteRef.current = focusNote;
			// Re-reading the same selection (a stray keyup) keeps the note intact.
			if (draftTextRef.current !== text) {
				setNote("");
			}
			draftTextRef.current = text;
			setDraft(next);
		},
		[containerRef]
	);

	useEffect(() => {
		const insidePopover = (target: EventTarget | null) =>
			target instanceof Node && Boolean(popoverRef.current?.contains(target));
		// mouseup/keyup finalize a selection; rAF lets it settle before we read it.
		// A drag goes straight into the note box; a keyboard selection may still be
		// extending, so it opens the box without stealing focus.
		const onMouseUp = (event: MouseEvent) => {
			if (!insidePopover(event.target)) {
				requestAnimationFrame(() => update(true));
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (!insidePopover(event.target)) {
				requestAnimationFrame(() => update(false));
			}
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!insidePopover(event.target)) {
				hide();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				hide();
			}
		};
		// The selection rect is viewport-relative; follow it while the transcript
		// scrolls so a half-written note is not thrown away.
		const onScroll = () => {
			setDraft((current) =>
				current ? (placeDraft(current.range, current.text) ?? current) : current
			);
		};
		document.addEventListener("mouseup", onMouseUp);
		document.addEventListener("keyup", onKeyUp);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			document.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [update, hide]);

	useEffect(() => {
		if (draft && focusNoteRef.current) {
			focusNoteRef.current = false;
			noteRef.current?.focus({ preventScroll: true });
		}
	}, [draft]);

	useEffect(() => hide, [hide]);

	if (!draft) {
		return null;
	}
	const actions = [...(selectionActions ?? [])]
		.filter((action) => action.kind === "button" && action.label.trim())
		.sort(
			(a: ContributedSelectionAction, b: ContributedSelectionAction) =>
				(a.order ?? Number.MAX_SAFE_INTEGER) -
					(b.order ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label)
		);
	const hasQuote = Boolean(onQuote);
	const trimmedNote = note.trim();

	const finish = () => {
		window.getSelection()?.removeAllRanges();
		hide();
	};
	const runQuote = () => {
		onQuote?.(draft.text, trimmedNote || undefined);
		finish();
	};
	const runAction = (action: ContributedSelectionAction) => {
		onContributedAction?.(
			action,
			trimmedNote
				? { note: trimmedNote, text: draft.text }
				: { text: draft.text }
		);
		finish();
	};
	const runPrimary = () => {
		if (hasQuote) {
			runQuote();
			return;
		}
		const [first] = actions;
		if (first) {
			runAction(first);
		}
	};

	return createPortal(
		<div
			aria-label="Annotate selection"
			className={cn(
				styles.anchor,
				styles.width,
				"fixed z-[60] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg",
				draft.placement === "above" && "-translate-y-full",
				className
			)}
			data-slot="selection-annotate"
			ref={popoverRef}
			role="dialog"
			style={
				{
					"--agent-top": `${draft.y}px`,
					"--agent-left": `${draft.x}px`,
					"--agent-width": `${POPOVER_WIDTH}px`,
				} satisfies AgentGeometryStyle as AgentGeometryStyle
			}
		>
			{/* Keeps the highlighted range visible after focus enters the note box. */}
			<style>{`::highlight(${SELECTION_HIGHLIGHT}){background-color:Highlight;color:HighlightText}`}</style>
			<label className="sr-only" htmlFor={noteId}>
				Note about the selected text
			</label>
			<textarea
				className="block max-h-40 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
				data-testid="selection-annotate-note"
				id={noteId}
				onChange={(event) => setNote(event.target.value)}
				onCopy={(event) => {
					// With nothing selected in the box, copy keeps copying the
					// highlighted message text, as it did before the box took focus.
					const target = event.currentTarget;
					if (target.selectionStart === target.selectionEnd) {
						event.preventDefault();
						event.clipboardData.setData("text/plain", draft.text);
					}
				}}
				onKeyDown={(event) => {
					if (
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						runPrimary();
					}
				}}
				placeholder="Add a note or question… (optional)"
				ref={noteRef}
				rows={2}
				value={note}
			/>
			<div
				className="flex flex-wrap items-center border-border border-t"
				data-slot="selection-toolbar"
				// Keep focus (and the typed note) in the box when an action is pressed.
				onMouseDown={(event) => event.preventDefault()}
			>
				{hasQuote && (
					<button
						className="flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-popover-foreground text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
						data-testid="selection-quote-action"
						onClick={runQuote}
						title={
							trimmedNote
								? "Quote in the composer with your note"
								: "Quote in the composer"
						}
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={QuoteDownIcon} />
						Quote
					</button>
				)}
				{hasQuote && actions.length > 0 && (
					<span aria-hidden="true" className="h-5 w-px bg-border" />
				)}
				{actions.map((action, index) => (
					<Fragment key={action.id}>
						{index > 0 && (
							<span aria-hidden="true" className="h-5 w-px bg-border" />
						)}
						<button
							aria-label={action.label}
							className="whitespace-nowrap px-2.5 py-1.5 font-medium text-popover-foreground text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
							data-selection-action-id={action.id}
							onClick={() => runAction(action)}
							title={action.label}
							type="button"
						>
							{action.label}
						</button>
					</Fragment>
				))}
			</div>
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
				"mx-2 mt-2 flex items-start gap-2 rounded-lg border-border border-l-2 bg-muted py-1.5 pr-1.5 pl-2",
				className
			)}
			data-slot="composer-quote-preview"
		>
			<HugeiconsIcon
				className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
				icon={QuoteDownIcon}
			/>
			<p className="type-detail line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground leading-snug">
				{text}
			</p>
			{onDismiss && (
				<button
					aria-label="Remove quote"
					className="shrink-0 rounded-lg p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onDismiss}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
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
				"type-detail mb-1.5 line-clamp-4 whitespace-pre-wrap border-border border-l-2 pl-2 text-muted-foreground leading-snug",
				className
			)}
		>
			{text}
		</p>
	);
}
