"use client";

import { Cancel01Icon, PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export interface ComposerMenuItem {
	badge?: string;
	description?: string;
	disabled?: boolean;
	icon?: ReactNode;
	id: string;
	keywords?: string[];
	label: string;
	/** A hover-revealed remove control in place of the pin (e.g. a saved draft). */
	onRemove?: () => void;
	trailing?: ReactNode;
}

export interface ComposerMenuGroup {
	id: string;
	items: ComposerMenuItem[];
	label: string;
}

export interface ComposerMenuProps {
	anchorRef?: RefObject<HTMLElement | null>;
	className?: string;
	embedded?: boolean;
	groups: ComposerMenuGroup[];
	onDismiss: () => void;
	onSelect: (item: ComposerMenuItem) => void;
	onTogglePin?: (item: ComposerMenuItem) => void;
	pinnedItemIds?: readonly string[];
	query?: string;
}

function matchesComposerMenuQuery(
	item: ComposerMenuItem,
	normalizedQuery: string
): boolean {
	return (
		!normalizedQuery ||
		[item.label, item.description ?? "", ...(item.keywords ?? [])]
			.join(" ")
			.toLowerCase()
			.includes(normalizedQuery)
	);
}

/** One searchable, keyboard-driven list used by +, @ mentions, and / commands. */
export function ComposerMenu({
	anchorRef,
	className,
	embedded = false,
	groups,
	onDismiss,
	onSelect,
	onTogglePin,
	pinnedItemIds = [],
	query = "",
}: ComposerMenuProps) {
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(0);
	const normalizedQuery = query.trim().toLowerCase();
	const pinnedSet = useMemo(() => new Set(pinnedItemIds), [pinnedItemIds]);
	const filteredGroups = useMemo(
		() =>
			groups.flatMap((group) => {
				const items = group.items.filter((item) =>
					matchesComposerMenuQuery(item, normalizedQuery)
				);
				return items.length > 0 ? [{ ...group, items }] : [];
			}),
		[groups, normalizedQuery]
	);
	const renderedGroups = useMemo(() => {
		const pinnedItems = pinnedItemIds.flatMap((id) => {
			for (const group of filteredGroups) {
				const item = group.items.find((candidate) => candidate.id === id);
				if (item) {
					return [item];
				}
			}
			return [];
		});
		const visibleGroups = filteredGroups.flatMap((group) => {
			const items = group.items.filter((item) => !pinnedSet.has(item.id));
			return items.length > 0 ? [{ ...group, items }] : [];
		});
		return pinnedItems.length > 0
			? [
					{ id: "pinned", items: pinnedItems, label: "Pinned" },
					...visibleGroups,
				]
			: visibleGroups;
	}, [filteredGroups, pinnedItemIds, pinnedSet]);
	const flat = useMemo(
		() => renderedGroups.flatMap((group) => group.items),
		[renderedGroups]
	);

	useEffect(() => setActive(0), [normalizedQuery, flat.length]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.target instanceof Element &&
				event.target.closest("[data-composer-pin-control]")
			) {
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				onDismiss();
				return;
			}
			if (flat.length === 0) {
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActive((index) => (index + 1) % flat.length);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setActive((index) => (index - 1 + flat.length) % flat.length);
			} else if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				event.stopPropagation();
				const item = flat[Math.min(active, flat.length - 1)];
				if (item && !item.disabled) {
					onSelect(item);
				}
			}
		};
		document.addEventListener("keydown", handleKeyDown, { capture: true });
		return () =>
			document.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [active, flat, onDismiss, onSelect]);

	useEffect(() => {
		if (!anchorRef) {
			return;
		}
		const handlePointerDown = (event: MouseEvent) => {
			// SAFETY: this Document pointer listener supplies native DOM-node targets;
			// contains reads that existing native ancestry without decoding input.
			const target = event.target as Node;
			if (
				!(
					rootRef.current?.contains(target) ||
					anchorRef.current?.contains(target)
				)
			) {
				onDismiss();
			}
		};
		document.addEventListener("mousedown", handlePointerDown);
		return () => document.removeEventListener("mousedown", handlePointerDown);
	}, [anchorRef, onDismiss]);

	let rowIndex = -1;
	return (
		<div
			className={cn(
				"overflow-y-auto",
				embedded
					? "max-h-[min(26rem,55vh)]"
					: "max-h-[min(26rem,55vh)] w-[min(44rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-1.5 shadow-lg",
				className
			)}
			ref={rootRef}
			role="listbox"
		>
			{renderedGroups.map((group, groupIndex) => (
				<div
					className={cn(groupIndex > 0 && "mt-1 border-border border-t pt-1")}
					key={group.id}
				>
					{/* Group labels earn their place only once there are more than
					    two groups; otherwise a hairline separates them. */}
					{renderedGroups.length > 2 ? (
						<div className="flex h-7 items-center px-2 text-muted-foreground text-xs">
							{group.label}
						</div>
					) : null}
					{group.items.map((item) => {
						rowIndex += 1;
						const index = rowIndex;
						return (
							<div
								className="group/option flex items-center rounded-lg"
								key={item.id}
							>
								<button
									aria-label={item.label}
									aria-selected={index === active}
									className={cn(
										"flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 hover:bg-accent hover:duration-0",
										index === active && "bg-accent",
										item.disabled && "cursor-not-allowed opacity-50"
									)}
									disabled={item.disabled}
									onClick={() => onSelect(item)}
									onMouseDown={(event) => event.preventDefault()}
									onMouseEnter={() => setActive(index)}
									role="option"
									// One line per row: the description is a tooltip, not a
									// second line under the label.
									title={item.description}
									type="button"
								>
									{item.icon ? (
										<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
											{item.icon}
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.badge ? (
										<span className="shrink-0 text-muted-foreground text-xs">
											{item.badge}
										</span>
									) : null}
									{item.trailing}
								</button>
								{item.onRemove ? (
									<button
										aria-label={tl("Delete {label}", { label: item.label })}
										className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/option:opacity-100 group-hover/option:duration-0"
										data-composer-pin-control
										onClick={(event) => {
											event.stopPropagation();
											item.onRemove?.();
										}}
										onMouseDown={(event) => event.preventDefault()}
										title={tl("Delete {label}", { label: item.label })}
										type="button"
									>
										<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
									</button>
								) : null}
								{onTogglePin && !item.onRemove ? (
									<button
										aria-label={
											pinnedSet.has(item.id)
												? tl("Unpin {label}", { label: item.label })
												: tl("Pin {label}", { label: item.label })
										}
										aria-pressed={pinnedSet.has(item.id)}
										className={cn(
											"flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
											"group-hover/option:opacity-100 group-hover/option:duration-0",
											pinnedSet.has(item.id) && "text-foreground opacity-100"
										)}
										data-composer-pin-control
										onClick={(event) => {
											event.stopPropagation();
											onTogglePin(item);
										}}
										onMouseDown={(event) => event.preventDefault()}
										title={
											pinnedSet.has(item.id)
												? tl("Unpin {label}", { label: item.label })
												: tl("Pin {label}", { label: item.label })
										}
										type="button"
									>
										<HugeiconsIcon
											className="size-3.5"
											icon={pinnedSet.has(item.id) ? PinOffIcon : PinIcon}
										/>
									</button>
								) : null}
							</div>
						);
					})}
				</div>
			))}
			{flat.length === 0 ? (
				<div className="px-3 py-6 text-center text-muted-foreground text-sm">
					No results found
				</div>
			) : null}
		</div>
	);
}
