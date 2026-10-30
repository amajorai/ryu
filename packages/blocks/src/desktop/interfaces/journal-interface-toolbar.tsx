import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Plus,
} from "lucide-react";
import {
	type JournalPager,
	VIEWS,
	writeSerif,
} from "./journal-interface-support.ts";
import {
	countLabel,
	type entryNeighbors,
	entryTitle,
	type JournalEntry,
	type JournalView,
	mediumDateLabel,
} from "./journal-model.ts";
import { JournalIconButton } from "./journal-parts.tsx";

interface JournalToolbarProps {
	activeEntry: JournalEntry | null;
	chooseView: (next: JournalView) => void;
	entryOpen: boolean;
	neighbors: ReturnType<typeof entryNeighbors>;
	newEntry: () => void;
	pager: JournalPager | null;
	selectDay: (key: string) => void;
	serif: boolean;
	setPane: (pane: "list" | "page") => void;
	setSerif: (serif: boolean) => void;
	stacked: boolean;
	stepEntry: (direction: -1 | 1) => void;
	todayKey: string;
	view: JournalView;
}

/** The page toolbar: entry stepping when an entry is open, else views and pager. */
export function JournalToolbar({
	activeEntry,
	chooseView,
	entryOpen,
	neighbors,
	newEntry,
	pager,
	selectDay,
	serif,
	setPane,
	setSerif,
	stacked,
	stepEntry,
	todayKey,
	view,
}: JournalToolbarProps) {
	const tl = useLiteralMessages();
	return (
		<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
			{stacked ? (
				<Button onClick={() => setPane("list")} size="sm" variant="ghost">
					<ChevronLeft
						aria-hidden="true"
						className="size-4"
						data-icon="inline-start"
					/>
					Entries
				</Button>
			) : null}
			{entryOpen ? (
				<>
					{stacked ? null : (
						<Button
							onClick={() => selectDay(activeEntry?.day ?? todayKey)}
							size="sm"
							variant="ghost"
						>
							<ChevronLeft
								aria-hidden="true"
								className="size-4"
								data-icon="inline-start"
							/>
							{mediumDateLabel(activeEntry?.day ?? todayKey)}
						</Button>
					)}
					<div className="ms-auto flex items-center gap-1">
						{neighbors.position > 0 ? (
							<span className="pe-2 text-muted-foreground text-xs tabular-nums">
								{neighbors.position} of{" "}
								{countLabel(neighbors.total, "entry", "entries")}
							</span>
						) : null}
						<JournalIconButton
							disabled={!neighbors.previous}
							hint={
								neighbors.previous
									? tl("Newer: {title}", {
											title: entryTitle(neighbors.previous.thread),
										})
									: "Newer entry"
							}
							keys={["⌥", "↑"]}
							label="Newer entry"
							onClick={() => stepEntry(-1)}
							shortcut="Alt+ArrowUp"
						>
							<ChevronUp aria-hidden="true" className="size-4" />
						</JournalIconButton>
						<JournalIconButton
							disabled={!neighbors.next}
							hint={
								neighbors.next
									? tl("Older: {title}", {
											title: entryTitle(neighbors.next.thread),
										})
									: "Older entry"
							}
							keys={["⌥", "↓"]}
							label="Older entry"
							onClick={() => stepEntry(1)}
							shortcut="Alt+ArrowDown"
						>
							<ChevronDown aria-hidden="true" className="size-4" />
						</JournalIconButton>
					</div>
				</>
			) : (
				<>
					<ToggleGroup
						appearance="segmented"
						aria-label="View"
						onValueChange={(values: unknown[]) => {
							const next = VIEWS.find((item) => item.id === values[0]);
							if (next) {
								chooseView(next.id);
							}
						}}
						spacing={0}
						value={[view]}
					>
						{VIEWS.map((item) => (
							<ToggleGroupItem
								density="segmented"
								key={item.id}
								value={item.id}
							>
								{item.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{pager ? (
						<div className="flex items-center max-sm:hidden">
							<JournalIconButton
								keys={pager.previousKeys}
								label={pager.previousLabel}
								onClick={() => pager.onStep(-1)}
								shortcut={pager.previousShortcut}
							>
								<ChevronLeft aria-hidden="true" className="size-4" />
							</JournalIconButton>
							<Button
								aria-disabled={pager.atToday || undefined}
								className={cn(
									pager.atToday &&
										"cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground"
								)}
								onClick={pager.atToday ? undefined : pager.onToday}
								size="sm"
								variant="ghost"
							>
								Today
							</Button>
							<JournalIconButton
								keys={pager.nextKeys}
								label={pager.nextLabel}
								onClick={() => pager.onStep(1)}
								shortcut={pager.nextShortcut}
							>
								<ChevronRight aria-hidden="true" className="size-4" />
							</JournalIconButton>
						</div>
					) : null}
					<div className="ms-auto flex items-center gap-1">
						<Tooltip>
							<TooltipTrigger
								render={
									<Toggle
										aria-label="Serif titles"
										className={cn(
											"text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-foreground aria-pressed:hover:bg-muted",
											serif ? "font-serif" : "font-sans"
										)}
										onPressedChange={(pressed: boolean) => {
											setSerif(pressed);
											writeSerif(pressed);
										}}
										pressed={serif}
										size="sm"
									/>
								}
							>
								{/* An element, not bare text: bare text gets its own overflow tooltip. */}
								<span>Aa</span>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{serif ? "Serif titles: on" : "Serif titles: off"}
							</TooltipContent>
						</Tooltip>
						<Button onClick={newEntry} size="sm" variant="default">
							<Plus
								aria-hidden="true"
								className="size-4"
								data-icon="inline-start"
							/>
							New entry
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
