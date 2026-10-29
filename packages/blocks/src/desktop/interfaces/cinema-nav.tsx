import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown, Plus, Search, X } from "lucide-react";
import { type RefObject, useId, useState } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { CINEMA_NAV, type CinemaCollectionId } from "./cinema-model.ts";

/** What the catalogue is showing: the home rows or one collection's page. */
export type CinemaPage = "home" | CinemaCollectionId;

const NAV_LABELS: Record<(typeof CINEMA_NAV)[number] | "home", string> = {
	attention: "Needs attention",
	continue: "Continue",
	home: "Home",
	list: "Pinned",
	live: "Live now",
	recent: "Recently updated",
	top: "Most active",
};

const PAGES: readonly CinemaPage[] = ["home", ...CINEMA_NAV];

function pageLabel(page: CinemaPage): string {
	const labels: Partial<Record<string, string>> = NAV_LABELS;
	return labels[page] ?? "Browse";
}

export interface CinemaNavProps {
	agents: readonly InterfaceAgent[];
	compact: boolean;
	gutter: number;
	onNavigate: (page: CinemaPage) => void;
	onNew: (agentId: string | null) => void;
	onQuery: (query: string) => void;
	page: CinemaPage;
	query: string;
	scrolled: boolean;
	searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * The top bar: page links (folded into Browse on narrow frames), an
 * expanding search box, and New thread. Transparent over the billboard, it
 * takes the page background once the catalogue scrolls.
 */
export function CinemaNav({
	agents,
	compact,
	gutter,
	onNavigate,
	onNew,
	onQuery,
	page,
	query,
	scrolled,
	searchRef,
}: CinemaNavProps) {
	const searchId = useId();
	const [searchOpen, setSearchOpen] = useState(false);
	const expanded = searchOpen || query.length > 0;
	const current = query ? null : page;
	return (
		<header
			className={cn(
				"sticky top-0 z-30 -mb-16 flex h-16 items-center gap-6 transition-colors duration-300",
				scrolled ? "bg-background" : "bg-transparent"
			)}
			style={{ paddingInline: gutter }}
		>
			{compact ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								className="-ml-2 gap-1 px-2 font-semibold"
								size="sm"
								type="button"
								variant="ghost"
							/>
						}
					>
						{current ? pageLabel(current) : "Browse"}
						<ChevronDown aria-hidden="true" className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						className="w-52"
						drawerLabel="Browse"
					>
						<DropdownMenuRadioGroup
							onValueChange={(value) => onNavigate(value as CinemaPage)}
							value={current ?? ""}
						>
							{PAGES.map((item) => (
								<DropdownMenuRadioItem key={item} value={item}>
									{pageLabel(item)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<nav aria-label="Browse">
					<ul className="flex items-center gap-5">
						{PAGES.map((item) => (
							<li key={item}>
								<button
									aria-current={item === current ? "page" : undefined}
									className={cn(
										"rounded-xs text-sm leading-5 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
										item === current
											? "font-semibold text-foreground"
											: "text-foreground/75 hover:text-foreground/55"
									)}
									onClick={() => onNavigate(item)}
									type="button"
								>
									{pageLabel(item)}
								</button>
							</li>
						))}
					</ul>
				</nav>
			)}
			<div className="ml-auto flex items-center gap-2">
				<div
					className={cn(
						"flex h-9 items-center rounded-sm transition-[width,background-color,border-color] duration-300",
						expanded
							? "border border-foreground/60 bg-background/80"
							: "border border-transparent",
						expanded && (compact ? "w-44" : "w-64")
					)}
					role="search"
				>
					<label
						className={cn(
							"flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground",
							!expanded && "hover:bg-foreground/10"
						)}
						htmlFor={searchId}
					>
						<Search aria-hidden="true" className="size-5" />
						<span className="sr-only">Search titles</span>
					</label>
					<input
						autoComplete="off"
						className={cn(
							"h-full min-w-0 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none",
							expanded ? "flex-1 pr-1" : "w-0"
						)}
						id={searchId}
						onBlur={() => setSearchOpen(false)}
						onChange={(event) => onQuery(event.target.value)}
						onFocus={() => setSearchOpen(true)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								onQuery("");
								event.currentTarget.blur();
							}
						}}
						placeholder="Titles, agents, projects"
						ref={searchRef}
						type="search"
						value={query}
					/>
					{query ? (
						<button
							aria-label="Clear search"
							className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => {
								onQuery("");
								searchRef.current?.focus();
							}}
							onMouseDown={(event) => event.preventDefault()}
							type="button"
						>
							<X aria-hidden="true" className="size-4" />
						</button>
					) : null}
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={compact ? "New thread" : undefined}
								className={cn("gap-1.5", compact ? "px-2" : "px-3")}
								size="sm"
								type="button"
								variant="ghost"
							/>
						}
					>
						<Plus aria-hidden="true" className="size-4" />
						{compact ? null : "New thread"}
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="w-60"
						drawerLabel="New thread"
					>
						{agents.length > 0 ? (
							<>
								<DropdownMenuGroup>
									<DropdownMenuLabel>Start a thread with</DropdownMenuLabel>
									{agents.map((agent) => (
										<DropdownMenuItem
											key={agent.id}
											onClick={() => onNew(agent.id)}
										>
											<BoardAvatar agent={agent} name={agent.name} size={20} />
											<span className="truncate">{agent.name}</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
							</>
						) : null}
						<DropdownMenuItem onClick={() => onNew(null)}>
							<Plus aria-hidden="true" />
							Blank thread
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}
