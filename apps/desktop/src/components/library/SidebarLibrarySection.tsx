import { Download01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	LibraryCard,
	type LibraryCardData,
	LibraryEmpty,
	LibraryGrid,
} from "@ryu/blocks/desktop/library";
import type {
	LibraryViewMode,
	ViewMode,
} from "@ryu/blocks/desktop/view-toggle";
import { BookCard } from "@ryu/ui/components/book-card.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useMemo } from "react";

export interface SidebarLibraryItem {
	icon: IconSvgElement;
	id: string;
	name: string;
	onOpen: () => void;
	secondaryAction?: { label: string; onSelect: () => void };
	subtitle?: string | null;
}

function SecondaryActionButton({
	action,
	className,
}: {
	action: NonNullable<SidebarLibraryItem["secondaryAction"]>;
	className: string;
}) {
	return (
		<Button
			aria-label={action.label}
			className={className}
			onClick={(event) => {
				event.stopPropagation();
				action.onSelect();
			}}
			onKeyDown={(event) => event.stopPropagation()}
			size="icon-sm"
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
		</Button>
	);
}

/** The generic Library surface for a built-in sidebar section. */
export default function SidebarLibrarySection({
	icon,
	items,
	label,
	loading = false,
	query,
	variant = "cards",
	view,
}: {
	icon: IconSvgElement;
	items: SidebarLibraryItem[];
	label: string;
	loading?: boolean;
	query: string;
	variant?: "cards" | "books";
	view: LibraryViewMode;
}) {
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return items;
		}
		return items.filter((item) =>
			[item.name, item.subtitle]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()
				.includes(needle)
		);
	}, [items, query]);

	if (loading && items.length === 0) {
		return (
			<div className="py-10 text-center text-muted-foreground text-sm">
				Loading…
			</div>
		);
	}

	if (visible.length === 0) {
		return (
			<LibraryEmpty
				description={
					query
						? "Nothing matches your search."
						: `${label} has nothing in it yet.`
				}
				icon={icon}
				title={query ? "No results" : "Nothing yet"}
			/>
		);
	}

	if (variant === "books" && view === "showcase") {
		return (
			<div className="flex flex-wrap gap-6 pt-1">
				{visible.map((item) => (
					<div className="group relative" key={item.id}>
						<div
							className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={item.onOpen}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									item.onOpen();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<BookCard
								coverArt={
									<div className="flex size-full items-center justify-center bg-muted text-muted-foreground">
										<HugeiconsIcon className="size-12" icon={item.icon} />
									</div>
								}
								footer={item.subtitle}
								title={item.name}
							/>
						</div>
						{item.secondaryAction ? (
							<SecondaryActionButton
								action={item.secondaryAction}
								className="absolute -top-2 -right-2 z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
							/>
						) : null}
					</div>
				))}
			</div>
		);
	}

	const standardView: ViewMode = view === "list" ? "list" : "grid";
	return (
		<LibraryGrid columns={2} view={standardView}>
			{visible.map((item) => {
				const card: LibraryCardData = {
					favorited: false,
					icon: item.icon,
					key: item.id,
					name: item.name,
					subtitle: item.subtitle ?? null,
				};
				return (
					<div className="group relative" key={item.id}>
						<LibraryCard item={card} onOpen={item.onOpen} view={standardView} />
						{item.secondaryAction ? (
							<SecondaryActionButton
								action={item.secondaryAction}
								className="absolute top-2 right-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
							/>
						) : null}
					</div>
				);
			})}
		</LibraryGrid>
	);
}
