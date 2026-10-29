import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ArrowUp } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
} from "react";

const MAX_PROMPT_LENGTH = 8000;

/**
 * A messaging-style composer. It never sends on its own: submitting is the
 * explicit user action that lets the host start a thread with the prompt.
 * Controlled, so Ideas can drop a suggestion in for the user to edit first.
 */
export function PersonaComposer({
	className,
	disabled = false,
	fieldRef,
	hint,
	label,
	onChange,
	onSubmit,
	placeholder,
	value,
}: {
	className?: string;
	disabled?: boolean;
	fieldRef?: RefObject<HTMLTextAreaElement | null>;
	/** A short line under the field (who receives it, what happens). */
	hint?: string;
	/** Accessible name for the text field. */
	label: string;
	onChange: (value: string) => void;
	onSubmit: (prompt: string) => void;
	placeholder: string;
	value: string;
}) {
	const fieldId = useId();
	const hintId = useId();
	const trimmed = value.trim();

	const submit = () => {
		if (!trimmed || disabled) {
			return;
		}
		onSubmit(trimmed);
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
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={onFormSubmit}
		>
			<div className="flex items-end gap-2">
				<label className="sr-only" htmlFor={fieldId}>
					{label}
				</label>
				<textarea
					aria-describedby={hint ? hintId : undefined}
					className="field-sizing-content max-h-40 min-h-10 min-w-0 flex-1 resize-none rounded-[20px] border border-border bg-background px-4 py-2 text-sm leading-6 outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
					disabled={disabled}
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					ref={fieldRef}
					rows={1}
					value={value}
				/>
				<Button
					aria-label="Send"
					className="size-10 rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
					disabled={!trimmed || disabled}
					size="icon"
					type="submit"
				>
					<ArrowUp aria-hidden="true" className="size-4.5" />
				</Button>
			</div>
			{hint ? (
				<p className="px-4 text-muted-foreground text-xs" id={hintId}>
					{hint}
				</p>
			) : null}
		</form>
	);
}
