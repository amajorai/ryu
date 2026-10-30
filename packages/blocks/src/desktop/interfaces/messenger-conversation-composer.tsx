import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@ryu/ui/components/input-group.tsx";
import { ArrowUp } from "lucide-react";
import { type FormEvent, type RefObject, useId, useState } from "react";

/**
 * A message box: Enter sends, Shift+Enter adds a line. Only text the user
 * typed and submitted here is ever passed to `onSend`.
 */
export function MessengerComposer({
	disabledReason,
	inputRef,
	label,
	onSend,
	placeholder,
}: {
	/** When set, sending is blocked and this explains why. */
	disabledReason?: string;
	inputRef?: RefObject<HTMLTextAreaElement | null>;
	label: string;
	onSend: (text: string) => void;
	placeholder: string;
}) {
	const [draft, setDraft] = useState("");
	const hintId = useId();
	const text = draft.trim();
	const canSend = text.length > 0 && !disabledReason;
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (!canSend) {
			return;
		}
		onSend(text);
		setDraft("");
	};
	return (
		<form
			aria-label={label}
			className="shrink-0 border-border border-t bg-background px-4 py-3"
			onSubmit={submit}
		>
			<InputGroup className="rounded-3xl border-border bg-background has-[textarea]:rounded-3xl">
				<InputGroupTextarea
					aria-describedby={disabledReason ? hintId : undefined}
					aria-label={placeholder}
					className="max-h-40 min-h-10 py-2.5 pl-4 text-sm"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={placeholder}
					ref={inputRef}
					rows={1}
					value={draft}
				/>
				<InputGroupAddon align="inline-end" className="self-end pb-1.5">
					<InputGroupButton
						aria-label="Send"
						className="rounded-full bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground disabled:bg-muted disabled:text-muted-foreground"
						disabled={!canSend}
						size="icon-sm"
						type="submit"
						variant="default"
					>
						<ArrowUp aria-hidden="true" />
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			{disabledReason ? (
				<p className="mt-1.5 px-4 text-muted-foreground text-xs" id={hintId}>
					{disabledReason}
				</p>
			) : null}
		</form>
	);
}
