// apps/desktop/src/components/chat/SlashCommandAutocomplete.tsx
//
// Floating autocomplete list that appears when the user types a leading "/" in
// the chat composer. Lists the slash commands the active agent advertised over
// ACP (`available_commands_update`, streamed to the desktop as a
// `data-ryu-acp-commands` part) plus Ryu's own local commands (/btw, /goal).
// Modeled on MentionAutocomplete: floats above the textarea, dismisses on click
// outside / Escape, and supports Up/Down + Enter/Tab keyboard selection.

import { useEffect, useRef, useState } from "react";

export interface SlashCommand {
	/** Human-readable description of what the command does. */
	description: string;
	/** Optional placeholder shown for the command's argument, if it takes one. */
	hint?: string | null;
	/** Command name without the leading slash (e.g. "compact", "btw"). */
	name: string;
	/** "agent" = advertised over ACP; "local" = handled by the desktop (btw/goal);
	 *  "plugin" = contributed by an enabled Core plugin (e.g. /proof). */
	source: "agent" | "local" | "plugin";
}

interface SlashCommandAutocompleteProps {
	/** Ref to the textarea element — used to keep the popover anchored to it. */
	anchorRef: React.RefObject<HTMLTextAreaElement | null>;
	/** The full command set to filter (agent commands first, then local). */
	commands: SlashCommand[];
	onDismiss: () => void;
	/** Called with the chosen command when a suggestion is selected. */
	onSelect: (command: SlashCommand) => void;
	/** The partial command name typed after "/" (may be empty). */
	query: string;
}

export function SlashCommandAutocomplete({
	commands,
	query,
	onSelect,
	onDismiss,
	anchorRef,
}: SlashCommandAutocompleteProps) {
	const listRef = useRef<HTMLUListElement>(null);
	const [active, setActive] = useState(0);
	const q = query.toLowerCase();
	const filtered = commands.filter((c) => c.name.toLowerCase().includes(q));

	// Reset the highlight to the top whenever the query narrows the list.
	useEffect(() => {
		setActive(0);
	}, []);

	// Dismiss on click outside (ignoring clicks on the anchored textarea).
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (
				listRef.current &&
				!listRef.current.contains(e.target as Node) &&
				anchorRef.current &&
				!anchorRef.current.contains(e.target as Node)
			) {
				onDismiss();
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [onDismiss, anchorRef]);

	// Keyboard navigation. Captured so Enter/Tab pick a command instead of the
	// textarea's Enter=send / Tab=blur while the popover is open.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onDismiss();
				return;
			}
			if (filtered.length === 0) {
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((i) => (i + 1) % filtered.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => (i - 1 + filtered.length) % filtered.length);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				onSelect(filtered[active]);
			}
		};
		document.addEventListener("keydown", handler, { capture: true });
		return () =>
			document.removeEventListener("keydown", handler, { capture: true });
	}, [filtered, active, onDismiss, onSelect]);

	if (filtered.length === 0) {
		return null;
	}

	return (
		<ul
			className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-80 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
			ref={listRef}
		>
			{filtered.map((cmd, i) => (
				<li key={`${cmd.source}:${cmd.name}`}>
					<button
						className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
							i === active ? "bg-muted" : ""
						}`}
						onClick={() => onSelect(cmd)}
						onMouseEnter={() => setActive(i)}
						type="button"
					>
						<span className="flex w-full items-center gap-1.5">
							<span className="font-medium text-primary">/{cmd.name}</span>
							{cmd.hint && (
								<span className="truncate text-muted-foreground text-xs">
									{cmd.hint}
								</span>
							)}
							{cmd.source === "local" && (
								<span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
									Ryu
								</span>
							)}
							{cmd.source === "plugin" && (
								<span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
									Plugin
								</span>
							)}
						</span>
						{cmd.description && (
							<span className="w-full truncate text-muted-foreground text-xs">
								{cmd.description}
							</span>
						)}
					</button>
				</li>
			))}
		</ul>
	);
}
