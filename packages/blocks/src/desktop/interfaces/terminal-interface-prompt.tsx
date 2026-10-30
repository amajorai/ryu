import { cn } from "@ryu/ui/lib/utils";
import type {
	Dispatch,
	FormEvent,
	KeyboardEvent,
	RefObject,
	SetStateAction,
} from "react";

/** The prompt line: cwd, the caret, and the command input. */
export function TerminalPrompt({
	cwd,
	gutter,
	historyIndex,
	input,
	inputId,
	inputRef,
	onKeyDown,
	onSubmit,
	setInput,
}: {
	cwd: string;
	gutter: string;
	/** Position while browsing history; null means editing the draft. */
	historyIndex: RefObject<number | null>;
	input: string;
	inputId: string;
	inputRef: RefObject<HTMLInputElement | null>;
	onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	setInput: Dispatch<SetStateAction<string>>;
}) {
	return (
		<form
			className={cn(
				"group/prompt flex shrink-0 items-center border-border border-t bg-muted/30 py-3",
				gutter
			)}
			onSubmit={onSubmit}
		>
			<label
				className="flex min-w-0 max-w-[50%] shrink-0 select-none"
				htmlFor={inputId}
			>
				<span className="sr-only">Terminal command</span>
				<span
					aria-hidden="true"
					className="shrink-0 text-muted-foreground group-focus-within/prompt:text-foreground"
				>
					you@ryu
				</span>
				<span
					aria-hidden="true"
					className="min-w-0 truncate whitespace-pre text-foreground"
				>
					{` ${cwd}`}
				</span>
				<span
					aria-hidden="true"
					className="shrink-0 whitespace-pre text-primary"
				>
					{" ❯ "}
				</span>
			</label>
			<input
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				className="block min-w-0 flex-1 bg-transparent p-0 text-foreground caret-foreground outline-none placeholder:text-muted-foreground/70"
				enterKeyHint="send"
				id={inputId}
				onChange={(event) => {
					setInput(event.target.value);
					historyIndex.current = null;
				}}
				onKeyDown={onKeyDown}
				placeholder="help, ls, or @agent <message>"
				ref={inputRef}
				spellCheck={false}
				type="text"
				value={input}
			/>
		</form>
	);
}
