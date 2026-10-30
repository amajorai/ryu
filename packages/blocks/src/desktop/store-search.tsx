"use client";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./store.module.css";

// The Store's library-wide search field and its collapsed search button.

/**
 * The Store's / Library's GLOBAL search: one muted `h-9` pill, in the page flow,
 * ABOVE the section tabs.
 *
 * It used to float at the bottom of the page (`StoreBottomSearch`), pinned
 * `absolute` over a padded content column. Two things were wrong with that. The
 * control that searches EVERYTHING sat below the tabs that scope a search to one
 * realm, so the page read bottom-up; and it forced every section in the shell to
 * reserve height for it whether or not it was scrolled to. Above the tabs it
 * reads in the order it works — search everything, or pick a realm — and the
 * shell's title row, which said nothing the tab strip did not already say, is
 * gone with it.
 *
 * It is one `h-9` pill, the form-control height; the compact expanding
 * {@link StoreSearchButton} still exists for per-section toolbars, which are
 * scoped searches sitting beside a list.
 *
 * The row's trailing slot (`trailing`) holds the section's own filter/source
 * controls, so the search and the things that narrow it stay on one line.
 */
export function StoreGlobalSearch({
	value,
	onChange,
	placeholder = "Search…",
	className,
	trailing,
}: {
	className?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Filter / source controls rendered beside the field, outside its pill. */
	trailing?: ReactNode;
	value: string;
}) {
	const localizedPlaceholder = useLocalizedString(placeholder);
	return (
		<div className={cn("flex w-full min-w-0 items-center gap-2", className)}>
			<div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-4">
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
					icon={Search01Icon}
				/>
				<input
					aria-label={localizedPlaceholder}
					// `type=search` for the semantics (role=searchbox), with the native
					// WebKit clear glyph suppressed — the row already has an explicit
					// Clear button, and two clear affordances in one field is chrome the
					// bare-input brief exists to avoid.
					className="h-full w-full min-w-0 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
					data-slot="store-global-search"
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && value.length > 0) {
							onChange("");
						}
					}}
					placeholder={localizedPlaceholder}
					type="search"
					value={value}
				/>
				{value ? (
					<Button
						aria-label="Clear search"
						onClick={() => onChange("")}
						size="icon-xs"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
					</Button>
				) : null}
			</div>
			{trailing}
		</div>
	);
}

/**
 * A search control shaped like the toolbar buttons beside it: a compact button
 * that expands into its input in place, and collapses again on Escape / an
 * outside click / blur while empty.
 *
 * A permanently-open full-width field is the wrong default for these pages — most
 * visits browse rather than search, and the field pushed the source and filter
 * buttons onto their own row. Expanding in place keeps one toolbar row and keeps
 * a non-empty query visible (it never auto-collapses while it has text).
 */
export function StoreSearchButton({
	value,
	onChange,
	placeholder = "Search…",
	className,
}: {
	className?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const localizedPlaceholder = useLocalizedString(placeholder);
	const localizedSearch = useLocalizedString("Search");
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const expanded = open || value.length > 0;

	useEffect(() => {
		if (open) {
			inputRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		const onPointer = (e: MouseEvent) => {
			// SAFETY: this Document mousedown listener receives native DOM-node targets,
			// the same-realm native Node receiver accepted by contains.
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [open]);

	return (
		<div className={cn("flex items-center", className)} ref={rootRef}>
			<Button
				aria-label="Search"
				onClick={() => setOpen((prev) => !prev)}
				size="sm"
				spacing="regular"
				variant={expanded ? "secondary" : "ghost"}
			>
				<HugeiconsIcon className="size-3.5" icon={Search01Icon} />
				{expanded ? null : localizedSearch}
			</Button>
			<div
				className={cn(
					"grid duration-200 ease-out",
					styles.panel,
					expanded ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
				)}
			>
				<div className="min-w-0 overflow-hidden">
					<Input
						aria-hidden={!expanded}
						aria-label={localizedPlaceholder}
						className="w-56 max-w-[40vw]"
						onChange={(e) => onChange(e.target.value)}
						placeholder={localizedPlaceholder}
						ref={inputRef}
						tabIndex={expanded ? 0 : -1}
						value={value}
						variant="store-search"
					/>
				</div>
			</div>
			{value ? (
				<Button
					aria-label="Clear search"
					onClick={() => {
						onChange("");
						setOpen(false);
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
				</Button>
			) : null}
		</div>
	);
}
