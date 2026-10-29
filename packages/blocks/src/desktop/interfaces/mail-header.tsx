import { cn } from "@ryu/ui/lib/utils";
import { Mail, Menu, Search, X } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { MailIconButton } from "./mail-parts.tsx";

/**
 * Gmail's top bar: the menu button that collapses the navigation, the
 * product mark, and the search box that searches all mail.
 */
export function MailHeader({
	compact,
	navOpen,
	onQueryChange,
	onSearchKeyDown,
	onToggleNav,
	query,
	searchRef,
}: {
	/** Hide the wordmark when the bar is short on room. */
	compact: boolean;
	navOpen: boolean;
	onQueryChange: (query: string) => void;
	onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	onToggleNav: () => void;
	query: string;
	searchRef: Ref<HTMLInputElement>;
}) {
	return (
		<header className="flex h-16 shrink-0 items-center pr-4 pl-2">
			<div
				className={cn(
					"flex shrink-0 items-center gap-1",
					compact ? "w-auto pr-2" : "w-62"
				)}
			>
				<MailIconButton
					className="size-10"
					label={navOpen ? "Collapse menu" : "Expand menu"}
					onClick={onToggleNav}
				>
					<Menu aria-hidden="true" className="size-5" />
				</MailIconButton>
				{compact ? null : (
					<span className="flex items-center gap-2 pl-1 text-foreground/80">
						<Mail
							aria-hidden="true"
							className="size-6 text-primary"
							strokeWidth={1.75}
						/>
						<span className="text-[22px] leading-none">Mail</span>
					</span>
				)}
			</div>
			<div
				className="relative flex h-12 min-w-0 max-w-[720px] flex-1 items-center"
				role="search"
			>
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute left-4 size-5 text-foreground/70"
				/>
				<input
					aria-keyshortcuts="/"
					aria-label="Search mail"
					className={cn(
						"h-full w-full rounded-full bg-foreground/6 pr-12 pl-13 text-base text-foreground outline-none transition-[background-color,box-shadow]",
						"placeholder:text-foreground/60 hover:bg-foreground/8",
						"focus:bg-background focus:shadow-md focus:ring-1 focus:ring-border"
					)}
					data-testid="mail-search"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={onSearchKeyDown}
					placeholder="Search mail"
					ref={searchRef}
					type="text"
					value={query}
				/>
				{query ? (
					<button
						aria-label="Clear search"
						className="absolute right-2 flex size-9 items-center justify-center rounded-full text-foreground/70 outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring/60"
						onClick={() => onQueryChange("")}
						type="button"
					>
						<X aria-hidden="true" className="size-5" />
					</button>
				) : null}
			</div>
		</header>
	);
}
