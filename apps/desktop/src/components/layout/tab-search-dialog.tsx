import {
	ArrowDown01Icon,
	Cancel01Icon,
	EyeOffIcon,
	Message01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import { AnimatedTitle } from "@/src/components/layout/animated-title.tsx";

export interface TabSearchTab {
	icon?: GlyphValue;
	id: string;
	path: string;
	title: string;
}

interface TabSearchDialogProps {
	activateTab: (id: string) => void;
	activeTabId: string;
	closeTab: (id: string) => void;
	floatingTabs: boolean;
	onHide: () => void;
	onOpenChange?: (open: boolean) => void;
	tabs: TabSearchTab[];
}

export function TabSearchRow({
	activeTabId,
	activateTab,
	closeTab,
	setOpen,
	tab,
}: {
	activeTabId: string;
	activateTab: (id: string) => void;
	closeTab: (id: string) => void;
	setOpen: (open: boolean) => void;
	tab: TabSearchTab;
}) {
	const tl = useLiteralMessages();
	const isActive = tab.id === activeTabId;

	return (
		<CommandItem
			className="min-h-12"
			data-active={isActive}
			data-tab-search-id={tab.id}
			onSelect={() => {
				activateTab(tab.id);
				setOpen(false);
			}}
			value={`${tab.title} ${tab.path}`}
		>
			<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
				{tab.icon ? (
					<GlyphDisplay size={16} value={tab.icon} />
				) : (
					<HugeiconsIcon className="size-4" icon={Message01Icon} />
				)}
			</span>
			<span className="min-w-0 flex-1 text-left">
				<span className="block truncate font-medium text-sm">
					<AnimatedTitle text={tab.title} />
				</span>
				<span
					className="block truncate text-muted-foreground text-xs"
					title={tab.path}
				>
					{tab.path}
				</span>
			</span>
			{isActive && (
				<span className="type-compact shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
					Current
				</span>
			)}
			<button
				aria-label={tl("Close {title}", { title: tab.title })}
				className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
				data-tab-search-close
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					closeTab(tab.id);
				}}
				onPointerDown={(event) => event.stopPropagation()}
				type="button"
			>
				<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
			</button>
		</CommandItem>
	);
}

/** Chrome-style tab search control for the horizontal workspace tab strip. */
export function TabSearchDialog({
	activeTabId,
	activateTab,
	closeTab,
	floatingTabs,
	onHide,
	onOpenChange,
	tabs,
}: TabSearchDialogProps) {
	const tl = useLiteralMessages();
	const [open, setOpenState] = useState(false);
	const setOpen = (next: boolean) => {
		setOpenState(next);
		onOpenChange?.(next);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<button
						aria-label="Search open tabs"
						className={cn(
							"ml-0.5 flex size-7 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-background/50 hover:text-muted-foreground",
							floatingTabs ? "rounded-full" : "rounded-t-lg"
						)}
						data-tab-search-trigger
						data-tauri-drag-region={false}
						onClick={() => setOpen(true)}
						title="Search open tabs"
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
					</button>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem onClick={onHide}>
					<HugeiconsIcon className="size-4" icon={EyeOffIcon} />
					Hide tab search button
				</ContextMenuItem>
			</ContextMenuContent>
			<CommandDialog
				description="Search and switch between every open workspace tab."
				onOpenChange={setOpen}
				open={open}
				title="Search open tabs"
			>
				<Command>
					<CommandInput autoFocus placeholder="Search open tabs…" />
					<CommandList className="max-h-[min(60vh,28rem)]">
						<CommandEmpty>No open tabs match your search.</CommandEmpty>
						<CommandGroup
							heading={tl(
								"{count, plural, one {# open tab} other {# open tabs}}",
								{
									count: tabs.length,
								}
							)}
						>
							{tabs.map((tab) => (
								<TabSearchRow
									activateTab={activateTab}
									activeTabId={activeTabId}
									closeTab={closeTab}
									key={tab.id}
									setOpen={setOpen}
									tab={tab}
								/>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</CommandDialog>
		</ContextMenu>
	);
}
