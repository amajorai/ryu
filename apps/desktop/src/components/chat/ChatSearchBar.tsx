import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Cancel01Icon,
	Chat01Icon,
	FolderOpenIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef } from "react";
import type { ChatSearchMatch } from "@/src/lib/chat-search.ts";

export type ChatSearchMode = "chat" | "files";

export interface ChatSearchBarProps {
	activeMatchIndex: number;
	folderAvailable: boolean;
	matches: readonly ChatSearchMatch[];
	mode: ChatSearchMode;
	onClose: () => void;
	onModeChange: (mode: ChatSearchMode) => void;
	onNextMatch: () => void;
	onPreviousMatch: () => void;
	onQueryChange: (query: string) => void;
	query: string;
}

/** Find bar shared by the current chat transcript and the workspace Files tab. */
export function ChatSearchBar({
	activeMatchIndex,
	folderAvailable,
	matches,
	mode,
	onClose,
	onModeChange,
	onNextMatch,
	onPreviousMatch,
	onQueryChange,
	query,
}: ChatSearchBarProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const frame = window.requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [mode]);

	const hasQuery = query.trim().length > 0;
	const chatHasMatches = matches.length > 0;
	const status =
		mode === "chat"
			? hasQuery
				? chatHasMatches
					? `${activeMatchIndex + 1} of ${matches.length}`
					: "No matches"
				: "Search messages"
			: folderAvailable
				? "Search project files"
				: "No project folder";

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "Enter" || mode !== "chat") {
			return;
		}
		event.preventDefault();
		if (event.shiftKey) {
			onPreviousMatch();
		} else {
			onNextMatch();
		}
	};

	return (
		<div
			aria-label="Chat search"
			className="pointer-events-auto absolute top-2 right-4 z-30 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
			data-testid="chat-search-bar"
			role="search"
		>
			<div
				aria-label="Search mode"
				className="flex shrink-0 items-center gap-0.5"
				role="group"
			>
				<button
					aria-pressed={mode === "chat"}
					className={cn(
						"flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors duration-150 hover:duration-0",
						mode === "chat"
							? "bg-accent text-foreground"
							: "text-muted-foreground hover:bg-muted hover:text-foreground"
					)}
					data-testid="chat-search-mode-chat"
					onClick={() => onModeChange("chat")}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={Chat01Icon} />
					Chat
				</button>
				<button
					aria-pressed={mode === "files"}
					className={cn(
						"flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors duration-150 hover:duration-0",
						mode === "files"
							? "bg-accent text-foreground"
							: "text-muted-foreground hover:bg-muted hover:text-foreground"
					)}
					data-testid="chat-search-mode-files"
					onClick={() => onModeChange("files")}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={FolderOpenIcon} />
					Files
				</button>
			</div>

			<div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 focus-within:ring-1 focus-within:ring-ring">
				<HugeiconsIcon
					className="size-4 shrink-0 text-muted-foreground"
					icon={Search01Icon}
				/>
				<input
					aria-label={
						mode === "chat" ? "Search chat messages" : "Search project files"
					}
					className="h-8 min-w-24 flex-1 bg-transparent text-sm caret-foreground outline-none placeholder:text-muted-foreground"
					data-testid="chat-search-input"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={mode === "chat" ? "Search messages…" : "Search files…"}
					ref={inputRef}
					spellCheck={false}
					value={query}
				/>
				<span
					aria-live="polite"
					className="shrink-0 whitespace-nowrap text-muted-foreground/70 text-xs tabular-nums"
					data-testid="chat-search-status"
				>
					{status}
				</span>
			</div>

			{mode === "chat" && (
				<div className="flex shrink-0 items-center gap-0.5">
					<Button
						aria-label="Previous chat match"
						disabled={!chatHasMatches}
						onClick={onPreviousMatch}
						size="icon-sm"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
					</Button>
					<Button
						aria-label="Next chat match"
						disabled={!chatHasMatches}
						onClick={onNextMatch}
						size="icon-sm"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
					</Button>
				</div>
			)}

			<span className="hidden shrink-0 px-1 text-muted-foreground/70 text-xs lg:inline">
				Ctrl/Cmd+F switches
			</span>
			<Button
				aria-label="Close chat search"
				className="shrink-0"
				onClick={onClose}
				size="icon-sm"
				type="button"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
			</Button>
		</div>
	);
}
