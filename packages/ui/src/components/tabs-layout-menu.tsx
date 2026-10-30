"use client";
import {
	DragDropVerticalIcon,
	FilterResetIcon,
	MoreHorizontalIcon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useState } from "react";
import {
	resolveTabsDrop,
	TABS_DRAG_MIME,
	type TabItem,
	type TabsDragController,
} from "./tabs-layout.ts";
import type { TabsValue } from "./tabs-root.tsx";

interface TabsLayoutMenuContentProps {
	activeKey: string | null;
	drag: TabsDragController;
	hiddenKeys: Set<string>;
	items: TabItem[];
	onClose: () => void;
	onHideToggle: (key: string) => void;
	onReset: () => void;
	onSelect: (value: TabsValue) => void;
	open: boolean;
	order: string[];
}

function TabsLayoutMenuContent({
	activeKey,
	drag,
	hiddenKeys,
	items,
	onClose,
	onHideToggle,
	onReset,
	onSelect,
	open,
	order,
}: TabsLayoutMenuContentProps) {
	const tl = useLiteralMessages();
	const [query, setQuery] = useState("");
	const itemByKey = useMemo(
		() => new Map(items.map((item) => [item.key, item])),
		[items]
	);
	const visibleItemCount = items.length - hiddenKeys.size;

	useEffect(() => {
		if (!open) {
			setQuery("");
		}
	}, [open]);

	return (
		<Command className="min-h-0 w-full p-0" shouldFilter>
			<CommandInput
				aria-label="Search tabs"
				autoFocus
				onValueChange={setQuery}
				placeholder="Search tabs…"
				value={query}
			/>
			<CommandList className="max-h-80">
				<CommandEmpty>No tabs found.</CommandEmpty>
				<CommandGroup heading="All tabs">
					{order.map((key) => {
						const item = itemByKey.get(key);
						if (!item) {
							return null;
						}
						const isHidden = hiddenKeys.has(key);
						const isActive = activeKey === key;
						// Rows slide apart to preview the drop; the line is a fallback.
						const isDragOver =
							drag.dropTarget?.key === key && !drag.menuShift.previewing;
						const dropBelow = isDragOver && !drag.dropTarget?.before;
						return (
							<CommandItem
								aria-current={isActive ? "page" : undefined}
								className={cn(
									"relative min-h-8 gap-1.5",
									isHidden && "text-muted-foreground opacity-50"
								)}
								data-tabs-menu-hidden={isHidden ? "true" : "false"}
								data-tabs-menu-key={key}
								key={key}
								onDragOver={(event) => {
									event.preventDefault();
									event.stopPropagation();
									event.dataTransfer.dropEffect = "move";
									const target = resolveTabsDrop(
										drag,
										drag.menuShift,
										order,
										key,
										event,
										"y"
									);
									drag.onDragOver(target.key, target.before);
								}}
								onDrop={(event) => {
									event.preventDefault();
									event.stopPropagation();
									const target = resolveTabsDrop(
										drag,
										drag.menuShift,
										order,
										key,
										event,
										"y"
									);
									drag.onDrop(
										target.key,
										target.before,
										event.dataTransfer.getData(TABS_DRAG_MIME) || undefined
									);
								}}
								onSelect={() => {
									onSelect(item.value);
									onClose();
								}}
								ref={drag.menuShift.register(key)}
								style={drag.menuShift.styleFor(key)}
								value={`${item.label} ${key}`}
							>
								{isDragOver && (
									<span
										aria-hidden
										className={cn(
											"pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary",
											dropBelow ? "bottom-0" : "top-0"
										)}
									/>
								)}
								<button
									aria-label={tl("Reorder {label}", { label: item.label })}
									className="corner-squircle flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground active:cursor-grabbing"
									draggable
									onClick={(event) => event.stopPropagation()}
									onDragEnd={drag.onDragEnd}
									onDragStart={(event) => {
										event.stopPropagation();
										drag.onDragStart(key, event);
									}}
									onPointerDown={(event) => event.stopPropagation()}
									type="button"
								>
									<HugeiconsIcon
										aria-hidden
										className="size-3.5"
										icon={DragDropVerticalIcon}
										strokeWidth={2}
									/>
								</button>
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{isHidden && (
									<HugeiconsIcon
										aria-hidden
										className="size-3.5 shrink-0"
										data-tabs-menu-hidden-indicator="true"
										icon={ViewOffSlashIcon}
										strokeWidth={2}
									/>
								)}
								{isActive && <span className="sr-only">Active</span>}
								<DropdownMenu>
									<DropdownMenuTrigger
										aria-label={tl("More actions for {label}", {
											label: item.label,
										})}
										className="corner-squircle flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
										onClick={(event) => event.stopPropagation()}
										onPointerDown={(event) => event.stopPropagation()}
										type="button"
									>
										<HugeiconsIcon
											aria-hidden
											className="size-3.5"
											icon={MoreHorizontalIcon}
											strokeWidth={2}
										/>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-36 p-1">
										<DropdownMenuItem
											disabled={!isHidden && visibleItemCount <= 1}
											onClick={(event) => {
												event.stopPropagation();
												onHideToggle(key);
											}}
										>
											<HugeiconsIcon
												aria-hidden
												className="size-3.5"
												icon={isHidden ? ViewIcon : ViewOffSlashIcon}
												strokeWidth={2}
											/>
											{isHidden
												? tl("Show {label}", { label: item.label })
												: tl("Hide {label}", { label: item.label })}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</CommandItem>
						);
					})}
				</CommandGroup>
			</CommandList>
			<div className="px-1 pb-1">
				<CommandSeparator />
				<Button
					className="mt-1 w-full justify-start"
					onClick={() => {
						onReset();
						onClose();
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={FilterResetIcon}
						strokeWidth={2}
					/>
					Reset tabs
				</Button>
			</div>
		</Command>
	);
}

export { TabsLayoutMenuContent };
