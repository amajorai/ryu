// Presentational command palette shared by the desktop app and the command bar.
//
// Pure props in, callbacks out: it renders a flat `CommandAction[]` with the
// shared `@ryu/ui` command primitives (cmdk under the hood) and owns none of the
// data. `chrome="dialog"` wraps it in the centered command dialog (the desktop's
// Cmd+K modal); `chrome="bare"` renders just the command surface so an embedder
// (the Electron command-bar window, which IS the panel) supplies its own frame.

import { HugeiconsIcon } from "@hugeicons/react";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
} from "@ryu/ui/components/command";
import { Fragment, type ReactNode } from "react";
import { actionSearchValue, groupActions } from "./registry.ts";
import type { CommandAction } from "./types.ts";

export interface CommandPaletteProps {
	/** Flat action list; grouped by `group` in first-seen order. */
	actions: CommandAction[];
	/** Focus the input on mount. */
	autoFocus?: boolean;
	/** How to frame the palette. `dialog` (default) = centered Cmd+K modal. */
	chrome?: "dialog" | "bare";
	/** Extra classes on the inner `Command`. */
	className?: string;
	/** Empty-results label. */
	emptyLabel?: string;
	/** Optional footer rendered under the list (hints, status). */
	footer?: ReactNode;
	/** Key handler on the input (e.g. submit a free-text query as a chat prompt). */
	onInputKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
	/** Dialog open-change handler (used by `chrome="dialog"`). */
	onOpenChange?: (open: boolean) => void;
	/** Forwarded to cmdk: search-change handler. */
	onSearchChange?: (value: string) => void;
	/** Dialog open state (used by `chrome="dialog"`). */
	open?: boolean;
	/** Search input placeholder. */
	placeholder?: string;
	/** Forwarded to cmdk: controlled search value. */
	search?: string;
	/** Forwarded to cmdk: when false, cmdk's built-in fuzzy filter is bypassed. */
	shouldFilter?: boolean;
}

function ActionRow({ action }: { action: CommandAction }) {
	return (
		<CommandItem
			data-checked={action.checked ? "true" : undefined}
			disabled={action.disabled}
			onSelect={action.onSelect}
			value={actionSearchValue(action)}
		>
			{action.icon ? (
				<HugeiconsIcon className="size-4 shrink-0" icon={action.icon} />
			) : null}
			<span className="truncate">{action.title}</span>
			{action.trailing ? (
				<span className="ml-auto truncate text-muted-foreground text-xs">
					{action.trailing}
				</span>
			) : null}
			{action.shortcut && !action.trailing ? (
				<CommandShortcut>{action.shortcut}</CommandShortcut>
			) : null}
		</CommandItem>
	);
}

function PaletteBody({
	actions,
	placeholder,
	emptyLabel,
	autoFocus,
	footer,
	className,
	shouldFilter,
	search,
	onSearchChange,
	onInputKeyDown,
}: Omit<CommandPaletteProps, "chrome" | "open" | "onOpenChange">) {
	const groups = groupActions(actions);
	return (
		<Command className={className} shouldFilter={shouldFilter}>
			<CommandInput
				autoFocus={autoFocus}
				onKeyDown={onInputKeyDown}
				onValueChange={onSearchChange}
				placeholder={placeholder ?? "Search or run a command..."}
				value={search}
			/>
			<CommandList>
				<CommandEmpty>{emptyLabel ?? "No results."}</CommandEmpty>
				{groups.map((group, index) => (
					<Fragment key={group.heading}>
						{index > 0 ? <CommandSeparator /> : null}
						<CommandGroup heading={group.heading}>
							{group.actions.map((action) => (
								<ActionRow action={action} key={action.id} />
							))}
						</CommandGroup>
					</Fragment>
				))}
			</CommandList>
			{footer}
		</Command>
	);
}

/**
 * The shared palette. Renders the same surface whether framed by the centered
 * command dialog (`chrome="dialog"`) or embedded bare in a host window
 * (`chrome="bare"`).
 */
export function CommandPalette({
	chrome = "dialog",
	open,
	onOpenChange,
	autoFocus = true,
	...body
}: CommandPaletteProps) {
	if (chrome === "bare") {
		return <PaletteBody autoFocus={autoFocus} {...body} />;
	}
	return (
		<CommandDialog onOpenChange={onOpenChange} open={open}>
			<PaletteBody autoFocus={autoFocus} {...body} />
		</CommandDialog>
	);
}
