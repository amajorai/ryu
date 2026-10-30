// Presentational command palette shared by the desktop app and the command bar.
//
// Search results and actions stay host-owned; this package renders them with the
// shared `@ryu/ui` command primitives (cmdk under the hood) and owns only view
// state. `chrome="dialog"` wraps it in the centered command dialog (the desktop's
// Cmd+K modal); `chrome="bare"` renders just the command surface so an embedder
// (the Electron command-bar window, which IS the panel) supplies its own frame.

import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
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
} from "@ryu/ui/components/command.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useState,
} from "react";
import { PaletteFilters } from "./palette-filters.tsx";
import { PaletteModeSwitch } from "./palette-mode-switch.tsx";
import { actionSearchValue, groupActions } from "./registry.ts";
import type {
	CommandAction,
	CommandPaletteMode,
	CommandPaletteTab,
} from "./types.ts";

export interface CommandPaletteProps {
	/** Flat action list; grouped by `group` in first-seen order. */
	actions: CommandAction[];
	/** Controlled result-type filter id. Defaults to the first tab. */
	activeTab?: string;
	/** Focus the input on mount. */
	autoFocus?: boolean;
	/** How to frame the palette. `dialog` (default) = centered Cmd+K modal. */
	chrome?: "dialog" | "bare";
	/** Extra classes on the inner `Command`. */
	className?: string;
	/** Optional compose view; enables the Search/Compose switch and Tab shortcut. */
	composeContent?: ReactNode;
	/** Shared dialog frame layout. */
	dialogLayout?: "default" | "expanded";
	/** Empty-results label. */
	emptyLabel?: string;
	/** Optional footer rendered under the list (hints, status). */
	footer?: ReactNode;
	/** Called when a row becomes the highlighted one (pointer or arrow keys), e.g.
	 *  to prefetch its `prefetchPath` before it is chosen. */
	onHighlight?: (action: CommandAction) => void;
	/** Key handler on the input (e.g. submit a free-text query as a chat prompt). */
	onInputKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
	/** Dialog open-change handler (used by `chrome="dialog"`). */
	onOpenChange?: (open: boolean) => void;
	/** Forwarded to cmdk: search-change handler. */
	onSearchChange?: (value: string) => void;
	/** Called when a result-type filter is selected. */
	onTabChange?: (tabId: string) => void;
	/** Dialog open state (used by `chrome="dialog"`). */
	open?: boolean;
	/** Search input placeholder. */
	placeholder?: string;
	/**
	 * Result-type lanes shown as chips; the rest sit behind "More". Defaults to
	 * All, Chats, Apps and Settings, topped up to four in host order.
	 */
	primaryTabIds?: string[];
	/** Forwarded to cmdk: controlled search value. */
	search?: string;
	/** Forwarded to cmdk: when false, cmdk's built-in fuzzy filter is bypassed. */
	shouldFilter?: boolean;
	/** Result-type filters rendered between the input and the result list. */
	tabs?: CommandPaletteTab[];
}

function ActionRow({ action }: { action: CommandAction }) {
	const localizedTitle = useLocalizedString(action.title);
	const localizedTrailing = useLocalizedText(action.trailing);
	return (
		<CommandItem
			data-checked={action.checked ? "true" : undefined}
			data-prefetch-path={action.prefetchPath}
			disabled={action.disabled}
			onSelect={action.onSelect}
			value={actionSearchValue(action)}
		>
			{action.icon ? (
				<HugeiconsIcon className="size-4 shrink-0" icon={action.icon} />
			) : null}
			<span className="min-w-0 flex-1 truncate" title={localizedTitle}>
				{localizedTitle}
			</span>
			{action.trailing ? (
				<span className="max-w-[40%] shrink-0 truncate text-muted-foreground text-xs">
					{localizedTrailing}
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
	tabs,
	activeTab,
	onTabChange,
	onHighlight,
	primaryTabIds,
}: Omit<
	CommandPaletteProps,
	"chrome" | "composeContent" | "dialogLayout" | "open" | "onOpenChange"
>) {
	const localizedPlaceholder = useLocalizedString(
		placeholder ?? "Search or run a command…"
	);
	const localizedEmptyLabel = useLocalizedString(emptyLabel ?? "No results.");
	const selectedTab = activeTab ?? tabs?.[0]?.id;
	const visibleActions =
		selectedTab && selectedTab !== "all"
			? actions.filter((action) => action.resultType === selectedTab)
			: actions;
	const groups = groupActions(visibleActions);
	// cmdk only reports highlight changes when its value is controlled, so the
	// palette owns the highlighted value whenever a host listens for it.
	const [highlighted, setHighlighted] = useState("");
	const handleHighlight = (value: string) => {
		setHighlighted(value);
		// cmdk may normalise case/whitespace of item values; compare loosely.
		const wanted = value.trim().toLowerCase();
		const action = visibleActions.find(
			(candidate) =>
				actionSearchValue(candidate).trim().toLowerCase() === wanted
		);
		if (action) {
			onHighlight?.(action);
		}
	};
	return (
		<Command
			className={cn("min-w-0 overflow-hidden", className)}
			onValueChange={onHighlight ? handleHighlight : undefined}
			shouldFilter={shouldFilter}
			value={onHighlight ? highlighted : undefined}
		>
			<CommandInput
				autoFocus={autoFocus}
				onKeyDown={onInputKeyDown}
				onValueChange={onSearchChange}
				placeholder={localizedPlaceholder}
				value={search}
			/>
			{tabs && tabs.length > 0 ? (
				<PaletteFilters
					onTabChange={onTabChange}
					primaryTabIds={primaryTabIds}
					selectedTab={selectedTab}
					tabs={tabs}
				/>
			) : null}
			<CommandList>
				<CommandEmpty>{localizedEmptyLabel}</CommandEmpty>
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
	composeContent,
	dialogLayout,
	...paletteProps
}: CommandPaletteProps) {
	const [activeMode, setActiveMode] = useState<CommandPaletteMode>("search");
	const modeId = useId();
	useEffect(() => {
		if (open === false) {
			setActiveMode("search");
		}
	}, [open]);

	const handleModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			composeContent === undefined ||
			event.key !== "Tab" ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey
		) {
			return;
		}
		event.preventDefault();
		setActiveMode((previous) => (previous === "search" ? "compose" : "search"));
	};

	const paletteContent =
		composeContent === undefined ? (
			<PaletteBody autoFocus={autoFocus} {...paletteProps} />
		) : (
			<div className="w-full min-w-0" onKeyDown={handleModeKeyDown}>
				<PaletteModeSwitch
					active={activeMode}
					composeTabId={`${modeId}-compose`}
					onChange={setActiveMode}
					searchTabId={`${modeId}-search`}
				/>
				<div
					aria-labelledby={`${modeId}-${activeMode}`}
					className="w-full"
					id={`${modeId}-panel`}
					role="tabpanel"
				>
					{activeMode === "compose" ? (
						composeContent
					) : (
						<PaletteBody autoFocus={autoFocus} {...paletteProps} />
					)}
				</div>
			</div>
		);

	if (chrome === "bare") {
		return paletteContent;
	}
	return (
		<CommandDialog
			// The palette's own frame: 640px wide (never wider than the window
			// less 16px a side), a 14px menu radius, and rows clipped to it.
			className="overflow-hidden! w-[min(640px,100vw-32px)] max-w-none! rounded-xl! sm:max-w-none!"
			layout={dialogLayout}
			onOpenChange={onOpenChange}
			open={open}
		>
			{paletteContent}
		</CommandDialog>
	);
}
