import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type SyntheticEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

const MAX_PROMPT_LENGTH = 8000;

/** Composer for a new conversation, inside the dialogue box. */
export function DialogComposer({
	agent,
	onCancel,
	onSubmit,
}: {
	agent: InterfaceAgent;
	onCancel: () => void;
	onSubmit: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	// Opening the composer is an explicit request to type: focus the field.
	useEffect(() => {
		field.current?.focus();
	}, []);
	const trimmed = prompt.trim();
	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="flex w-full flex-col gap-2" onSubmit={onFormSubmit}>
			<label className="sr-only" htmlFor={fieldId}>
				{tl("Say something to {name}", { name: agent.name })}
			</label>
			<textarea
				aria-describedby={hintId}
				className="max-h-28 min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-foreground text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={tl("Say something to {name}", { name: agent.name })}
				ref={field}
				rows={2}
				value={prompt}
			/>
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-xs" id={hintId}>
					Enter to send · Shift+Enter for a new line · Esc to cancel
				</p>
				<Button disabled={!trimmed} size="sm" type="submit">
					Send
				</Button>
			</div>
		</form>
	);
}
