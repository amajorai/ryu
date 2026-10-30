"use client";

import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ReactNode, useRef } from "react";
import type { BrowserPageContext } from "./browser-context.ts";
import {
	MAX_BROWSER_PAGE_TEXT_CHARS,
	MAX_BROWSER_SELECTION_CHARS,
} from "./docs.ts";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";

/**
 * One opt-in context chip, in Desktop's page-context chip style: a quiet
 * "Add …" pill until chosen, then a muted chip whose label opens a read-only
 * preview of exactly what will be sent, plus a remove control.
 *
 * The preview is portaled to `<body>`, so it carries the widget marker (its
 * caret and text never replace the stored page selection), opens with focus on
 * the dialog rather than inside the preview text, and keeps clicks from
 * bubbling to the composer card, which would move focus and close it.
 */
function ContextChip({
	addLabel,
	included,
	label,
	onChange,
	preview,
	previewDescription,
	previewTitle,
}: {
	addLabel: string;
	included: boolean;
	label: string;
	onChange: (value: boolean) => void;
	preview: ReactNode;
	previewDescription?: string;
	previewTitle: string;
}) {
	const popupRef = useRef<HTMLDivElement>(null);
	if (!included) {
		return (
			<button
				className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-muted-foreground text-xs transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground"
				onClick={() => onChange(true)}
				type="button"
			>
				<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
				{addLabel}
			</button>
		);
	}
	return (
		<span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full bg-muted ps-2 pe-1 text-muted-foreground text-xs">
			<Popover>
				<PopoverTrigger
					render={
						<button
							aria-label={`Review ${previewTitle.toLowerCase()}`}
							className="min-w-0 truncate rounded-full hover:text-foreground"
							type="button"
						>
							{label}
						</button>
					}
				/>
				<PopoverContent
					align="start"
					className="w-80"
					data-lenis-prevent=""
					data-ryu-assistant-widget="true"
					initialFocus={popupRef}
					onClick={(event) => event.stopPropagation()}
					onMouseDown={(event) => event.stopPropagation()}
					positionerClassName={ASSISTANT_POPUP_LAYER}
					ref={popupRef}
					spacing="compact"
				>
					<PopoverHeader>
						<PopoverTitle>{previewTitle}</PopoverTitle>
						{previewDescription ? (
							<PopoverDescription className="break-all">
								{previewDescription}
							</PopoverDescription>
						) : null}
					</PopoverHeader>
					{preview}
					<p className="text-detail text-muted-foreground">
						Sent to the selected runtime with your next question.
					</p>
				</PopoverContent>
			</Popover>
			<button
				aria-label={`Remove ${previewTitle.toLowerCase()} from context`}
				className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-background hover:text-foreground"
				onClick={() => onChange(false)}
				type="button"
			>
				<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
			</button>
		</span>
	);
}

function previewText(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n[Preview truncated]`
		: text;
}

/** Opt-in page and selection context, rendered in the composer header slot. */
export function PageContextChips({
	context,
	includePage,
	includeSelection,
	onIncludePageChange,
	onIncludeSelectionChange,
}: {
	context: BrowserPageContext;
	includePage: boolean;
	includeSelection: boolean;
	onIncludePageChange: (value: boolean) => void;
	onIncludeSelectionChange: (value: boolean) => void;
}) {
	const hasPageContext = Boolean(
		context.title || context.url || context.text.trim()
	);
	const selection = context.selection?.trim() ?? "";
	if (!(hasPageContext || selection)) {
		return null;
	}
	return (
		<fieldset
			className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 px-3 pt-2 pb-0"
			data-testid="assistant-page-context"
		>
			<legend className="sr-only">Webpage context</legend>
			{hasPageContext ? (
				<ContextChip
					addLabel="Add current page"
					included={includePage}
					label={context.title || "Current page"}
					onChange={onIncludePageChange}
					preview={
						<Textarea
							aria-label="Readable text from the current page"
							className="field-sizing-fixed h-32 max-h-32 min-h-0 w-full overflow-auto whitespace-pre-wrap break-words"
							readOnly
							rows={6}
							size="context-preview"
							value={previewText(context.text, MAX_BROWSER_PAGE_TEXT_CHARS)}
							variant="read-only-preview"
						/>
					}
					previewDescription={context.url}
					previewTitle="Page text"
				/>
			) : null}
			{selection ? (
				<ContextChip
					addLabel="Add selected text"
					included={includeSelection}
					label="Selected text"
					onChange={onIncludeSelectionChange}
					preview={
						<Textarea
							aria-label="Selected page text available as context"
							className="field-sizing-fixed h-20 max-h-20 min-h-0 w-full overflow-auto whitespace-pre-wrap break-words"
							readOnly
							rows={3}
							size="selection-preview"
							value={previewText(selection, MAX_BROWSER_SELECTION_CHARS)}
							variant="read-only-preview"
						/>
					}
					previewTitle="Selected text"
				/>
			) : null}
		</fieldset>
	);
}
