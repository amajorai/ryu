// apps/desktop/src/components/chat/MentionMenu.tsx
//
// The grouped "@" mention menu. Floats above the composer (absolute, bottom-full)
// and lists candidates in labelled sections — Agents, Teams, Plugins, Skills,
// MCP, Spaces, Folders — each row carrying its kind icon. Full keyboard nav
// (Up/Down across the flattened list, Enter/Tab to pick, Escape to dismiss),
// modelled on SlashCommandAutocomplete. Supersedes the flat agents/teams-only
// MentionAutocomplete. See docs/rfc-mention-composer.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { flattenGroups } from "@/src/lib/mentions/candidates.ts";
import type { MentionGroup, MentionItem } from "@/src/lib/mentions/types.ts";

interface MentionMenuProps {
	/** Ref to the textarea — used to ignore outside-click dismissal on it. */
	anchorRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Already-filtered, ordered candidate sections. */
	groups: MentionGroup[];
	onDismiss: () => void;
	/** Called with the chosen candidate. */
	onSelect: (item: MentionItem) => void;
}

export function MentionMenu({
	groups,
	onSelect,
	onDismiss,
	anchorRef,
}: MentionMenuProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(0);
	const flat = useMemo(() => flattenGroups(groups), [groups]);

	// Reset the highlight to the top whenever the candidate set changes.
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

	// Keyboard navigation. Captured so Enter/Tab pick a mention instead of the
	// textarea's Enter=send / Tab=blur while the menu is open.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onDismiss();
				return;
			}
			if (flat.length === 0) {
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((i) => (i + 1) % flat.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => (i - 1 + flat.length) % flat.length);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				onSelect(flat[active]);
			}
		};
		document.addEventListener("keydown", handler, { capture: true });
		return () =>
			document.removeEventListener("keydown", handler, { capture: true });
	}, [flat, active, onDismiss, onSelect]);

	if (flat.length === 0) {
		return null;
	}

	// Running index across sections so the active row lines up with keyboard nav.
	let flatIndex = -1;

	return (
		<div
			className="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
			ref={listRef}
		>
			{groups.map((group) => (
				<div key={group.kind}>
					<div className="px-2 pt-1.5 pb-1 font-medium text-[11px] text-muted-foreground">
						{group.label}
					</div>
					{group.items.map((item) => {
						flatIndex += 1;
						const i = flatIndex;
						const Icon = item.icon;
						const isPlugin = item.kind === "plugin";
						return (
							<button
								className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
									i === active ? "bg-accent" : ""
								}`}
								key={`${item.kind}:${item.id}`}
								onMouseDown={(e) => {
									// Keep textarea focus through the click.
									e.preventDefault();
									onSelect(item);
								}}
								onMouseEnter={() => setActive(i)}
								type="button"
							>
								{Icon && (
									<Icon
										className={
											isPlugin
												? "size-4 shrink-0 text-primary"
												: "size-4 shrink-0 text-muted-foreground"
										}
									/>
								)}
								<span className="min-w-0 flex-1">
									<span className="block truncate">{item.label}</span>
									{item.description && (
										<span className="block truncate text-muted-foreground text-xs">
											{item.description}
										</span>
									)}
								</span>
								{isPlugin && (
									<span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
										plugin
									</span>
								)}
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
