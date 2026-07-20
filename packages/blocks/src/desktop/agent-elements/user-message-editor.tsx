import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

export interface UserMessageEditorProps {
	className?: string;
	initialText: string;
	onCancel: () => void;
	onSubmit: (text: string) => void;
}

const MAX_ROWS = 8;
const MIN_ROWS = 2;

/**
 * Inline editor for a past user turn — the LobeChat "edit & resend as a new
 * branch" affordance. Saving does NOT mutate the current thread: the surface
 * forks the conversation just before this message and resends the edited text
 * into the fresh branch (see ChatPage.handleEditBranch), leaving the original
 * intact. Purely presentational; all fork/resend logic lives in the surface.
 */
export function UserMessageEditor({
	className,
	initialText,
	onCancel,
	onSubmit,
}: UserMessageEditorProps) {
	const [value, setValue] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const trimmed = value.trim();

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.focus();
		// Place the caret at the end so editing continues from where the user left
		// off rather than selecting the whole message.
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);

	const submit = () => {
		if (trimmed) {
			onSubmit(trimmed);
		}
	};

	const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, value.split("\n").length));

	return (
		<div className={cn("flex w-full flex-col items-end gap-2", className)}>
			<textarea
				aria-label="Edit message"
				className="w-full resize-y rounded-2xl bg-muted px-3.5 py-2 text-foreground text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary/40"
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
						return;
					}
					if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
						event.preventDefault();
						submit();
					}
				}}
				ref={textareaRef}
				rows={rows}
				value={value}
			/>
			<div className="flex items-center gap-2">
				<Button onClick={onCancel} size="xs" type="button" variant="ghost">
					Cancel
				</Button>
				<Button disabled={!trimmed} onClick={submit} size="xs" type="button">
					Branch &amp; resend
				</Button>
			</div>
		</div>
	);
}
