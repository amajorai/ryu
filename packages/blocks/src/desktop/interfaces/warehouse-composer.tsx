import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The items field of Create order. Submitting is the user's explicit send,
 * so the host may start the thread at once; nothing is sent until then.
 * The submit stays a quiet secondary button until there is text to send.
 */
export function OrderItemsComposer({
	fulfillerName,
	onSubmit,
}: {
	fulfillerName: string | undefined;
	onSubmit: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();
	const ready = trimmed.length > 0;

	const submit = () => {
		if (!ready) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
		<form className="flex flex-col gap-2" onSubmit={onFormSubmit}>
			<label className="text-muted-foreground text-xs" htmlFor={fieldId}>
				Items
			</label>
			<div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
				<Textarea
					className="min-h-20 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						fulfillerName
							? tl("What should {fulfillerName} do?", { fulfillerName })
							: "What needs doing?"
					}
					value={prompt}
				/>
				<div className="flex items-center justify-between gap-2 ps-1">
					<span className="text-muted-foreground text-xs">
						Enter to create, Shift+Enter for a new line
					</span>
					<Button
						disabled={!ready}
						size="sm"
						type="submit"
						variant={ready ? "default" : "secondary"}
					>
						Create order
					</Button>
				</div>
			</div>
		</form>
	);
}
