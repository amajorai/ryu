import { Button } from "@ryu/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { isImeComposingKeyEvent } from "./composer-send-shortcut.ts";

/**
 * Inline editor shown in place of a user bubble while editing. Enter saves
 * (Shift+Enter inserts a newline), Escape cancels. Mirrors the composer's
 * right-aligned bubble styling so the edit feels in-place.
 */
export function UserMessageEditor({
	initialText,
	onSubmit,
	onCancel,
}: {
	initialText: string;
	onSubmit?: (text: string) => void;
	onCancel?: () => void;
}) {
	const [value, setValue] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.focus();
			// Place the caret at the end and grow to fit the content.
			el.setSelectionRange(el.value.length, el.value.length);
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, []);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onSubmit?.(trimmed);
		}
	};

	// No width cap of its own: the field fills the bubble column, which already
	// carries the message's max width. The old `max-w-[calc(95%-40px)]` was a
	// second, different basis, so the editor was visibly wider than the bubble it
	// replaced.
	return (
		<div className="flex w-full flex-col items-end gap-2">
			<div
				className="w-full rounded-2xl bg-muted px-3.5 py-2"
				data-slot="user-message-editor"
			>
				<textarea
					aria-label="Edit message"
					className="w-full resize-none bg-transparent text-foreground text-sm leading-5 outline-none"
					onChange={(event) => {
						setValue(event.target.value);
						event.target.style.height = "auto";
						event.target.style.height = `${event.target.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						// Leave Enter/Escape to the IME while a CJK composition is open.
						if (isImeComposingKeyEvent(event.nativeEvent)) {
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							onCancel?.();
						}
					}}
					ref={textareaRef}
					rows={1}
					value={value}
				/>
			</div>
			<div className="flex items-center gap-2">
				<Button
					onClick={onCancel}
					radius="pill"
					size="compact"
					type="button"
					variant="ghost"
				>
					Cancel
				</Button>
				<Button
					disabled={!value.trim()}
					onClick={submit}
					radius="pill"
					size="compact"
					type="button"
				>
					Send
				</Button>
			</div>
		</div>
	);
}
