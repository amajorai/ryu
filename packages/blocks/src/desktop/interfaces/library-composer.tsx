import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
	useState,
} from "react";

const MAX_PROMPT_LENGTH = 8000;

/**
 * "Write a chapter": the next chapter's number, a prompt, and (in a
 * collection with several authors) who writes it. Submitting is the explicit
 * user action that lets the host send immediately.
 */
export function ChapterComposer({
	authors,
	chapterNumber,
	defaultAgentId,
	fieldRef,
	onSubmit,
	subject,
}: {
	/** Offer a picker when more than one agent can write the chapter. */
	authors: InterfaceAgent[];
	chapterNumber: number;
	defaultAgentId: string | null;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	onSubmit: (input: { agentId: string | null; prompt: string }) => void;
	/** Whom or what the chapter is for, as the placeholder names it. */
	subject: string;
}) {
	const fieldId = useId();
	const hintId = useId();
	const tl = useLiteralMessages();
	const [prompt, setPrompt] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
	// Resolve on every render, so a pick the authors no longer include can
	// never send to a hidden agent: what the picker shows is what gets sent.
	const agentId =
		pickedAgentId && authors.some((author) => author.id === pickedAgentId)
			? pickedAgentId
			: (defaultAgentId ?? authors[0]?.id ?? null);
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId, prompt: trimmed });
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
		<form
			aria-label="Write a chapter"
			className="rounded-lg border border-border bg-card transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 motion-reduce:transition-none"
			onSubmit={onFormSubmit}
		>
			<label
				className="block px-4 pt-3 font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]"
				htmlFor={fieldId}
			>
				{tl("Chapter {chapterNumber}", {
					chapterNumber: String(chapterNumber),
				})}
			</label>
			<Textarea
				aria-describedby={hintId}
				className="min-h-16 resize-none border-0 bg-transparent px-4 pt-1.5 pb-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={tl("Start a new conversation with {subject}", { subject })}
				ref={fieldRef}
				value={prompt}
			/>
			<div className="flex items-center justify-between gap-3 border-border border-t px-3 py-2">
				{authors.length > 1 ? (
					<NativeSelect
						aria-label="Written by"
						className="w-40"
						onChange={(event) => setPickedAgentId(event.target.value)}
						size="sm"
						value={agentId ?? undefined}
					>
						{authors.map((author) => (
							<NativeSelectOption key={author.id} value={author.id}>
								{author.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				) : null}
				<p
					className="mr-auto @2xl/library:block hidden text-muted-foreground text-xs"
					id={hintId}
				>
					Enter to send, Shift+Enter for a new line
				</p>
				<Button disabled={!trimmed} size="sm" type="submit">
					Write chapter
				</Button>
			</div>
		</form>
	);
}
