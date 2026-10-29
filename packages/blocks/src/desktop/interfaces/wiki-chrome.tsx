import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	FolderClosed,
	Menu,
	MessageSquareText,
	Search,
	Users,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	WIKI_INDEX_LABELS,
	WIKI_INDEX_ORDER,
	WIKI_MAIN,
	type WikiEntry,
	type WikiRoute,
	wikiAgent,
	wikiSuggest,
} from "./wiki-model.ts";
import {
	Marked,
	routeHref,
	useWikiNav,
	WikiLink,
	WikiMark,
	WikiPortrait,
} from "./wiki-parts.tsx";

const SUGGESTION_LIMIT = 6;
const QUIET_BUTTON =
	"inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[2px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:bg-accent aria-expanded:bg-muted";

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

/** Main page, Recent changes, then Contents: the four index pages. */
export function WikiMainMenu({
	onPinToggle,
	pinned,
}: {
	onPinToggle?: () => void;
	pinned: boolean;
}) {
	return (
		<nav aria-label="Main menu" className="text-sm">
			<div className="flex items-center justify-between border-border border-b pb-1">
				<h2 className="font-semibold text-muted-foreground text-xs leading-6">
					Main menu
				</h2>
				{onPinToggle ? (
					<button
						className="cursor-pointer rounded-[2px] px-1.5 text-muted-foreground text-xs leading-6 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onPinToggle}
						type="button"
					>
						{pinned ? "hide" : "move to sidebar"}
					</button>
				) : null}
			</div>
			<ul className="pt-1">
				<MenuItem route={WIKI_MAIN}>Main page</MenuItem>
				<MenuItem route={{ kind: "changes" }}>Recent changes</MenuItem>
			</ul>
			<h3 className="pt-3 pb-1 font-semibold text-muted-foreground text-xs leading-5">
				Contents
			</h3>
			<ul>
				{WIKI_INDEX_ORDER.map((index) => (
					<MenuItem key={index} route={{ index, kind: "index" }}>
						{WIKI_INDEX_LABELS[index]}
					</MenuItem>
				))}
			</ul>
		</nav>
	);
}

function MenuItem({
	children,
	route,
}: {
	children: ReactNode;
	route: WikiRoute;
}) {
	return (
		<li>
			<WikiLink className="block py-1 leading-6" route={route}>
				{children}
			</WikiLink>
		</li>
	);
}

/** The main menu as a dropdown under the header's menu button. */
function MenuDropdown({
	onClose,
	onPin,
	triggerRef,
}: {
	onClose: () => void;
	onPin?: () => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const reduceMotion = useReducedMotion();
	useEffect(() => {
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				!panelRef.current?.contains(target) &&
				!triggerRef.current?.contains(target)
			) {
				onClose();
			}
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [onClose, triggerRef]);
	useEffect(() => {
		panelRef.current?.querySelector<HTMLElement>("a")?.focus();
	}, []);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			triggerRef.current?.focus();
		}
	};
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="absolute top-full left-0 z-40 mt-1 w-52 border border-border bg-popover px-3 pt-2 pb-3 text-popover-foreground shadow-md"
			exit={{ opacity: 0, y: -4 }}
			initial={{ opacity: 0, y: -4 }}
			onKeyDown={onKeyDown}
			ref={panelRef}
			transition={reduceMotion ? { duration: 0 } : { duration: 0.12 }}
		>
			<WikiMainMenu onPinToggle={onPin} pinned={false} />
		</motion.div>
	);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function WikiHeader({
	menuOpen,
	menuPinned,
	onMenuOpenChange,
	onPin,
	onSearch,
	scrolled,
	searchRef,
	showMenuButton,
	snapshot,
}: {
	menuOpen: boolean;
	menuPinned: boolean;
	onMenuOpenChange: (open: boolean) => void;
	/** Pin the main menu into the sidebar (wide layouts only). */
	onPin?: () => void;
	onSearch: (query: string) => void;
	scrolled: boolean;
	searchRef: RefObject<HTMLInputElement | null>;
	showMenuButton: boolean;
	snapshot: InterfaceSnapshot;
}) {
	const nav = useWikiNav();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const goHome = (event: { preventDefault: () => void }) => {
		event.preventDefault();
		nav.go(WIKI_MAIN);
	};
	return (
		<header
			className={cn(
				"relative z-30 shrink-0 border-b bg-background transition-colors",
				scrolled ? "border-border" : "border-transparent"
			)}
		>
			<div className="mx-auto flex h-14 w-full max-w-[1280px] items-center @[640px]/wiki:gap-8 gap-3 @[640px]/wiki:px-6 px-4">
				<div
					className={cn(
						"relative flex shrink-0 items-center gap-2",
						menuPinned && "w-44"
					)}
				>
					{showMenuButton ? (
						<button
							aria-expanded={menuOpen}
							aria-label="Main menu"
							className={cn(QUIET_BUTTON, "-ml-1.5")}
							onClick={() => onMenuOpenChange(!menuOpen)}
							ref={triggerRef}
							type="button"
						>
							<Menu aria-hidden="true" className="size-5" strokeWidth={1.75} />
						</button>
					) : null}
					<AnimatePresence>
						{showMenuButton && menuOpen ? (
							<MenuDropdown
								onClose={() => onMenuOpenChange(false)}
								onPin={onPin}
								triggerRef={triggerRef}
							/>
						) : null}
					</AnimatePresence>
					<a
						aria-label="Workspace Wiki, main page"
						className="flex shrink-0 items-center gap-2 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
						href={routeHref(WIKI_MAIN)}
						onClick={goHome}
					>
						<WikiMark className="size-8 text-foreground" />
						<span className="@[560px]/wiki:flex hidden flex-col">
							<span className="font-serif text-[14px] text-foreground uppercase leading-5 tracking-[0.1em]">
								Workspace Wiki
							</span>
							<span className="font-serif text-muted-foreground text-xs leading-4">
								The workspace encyclopedia
							</span>
						</span>
					</a>
				</div>
				<WikiSearch
					inputRef={searchRef}
					onSearch={onSearch}
					snapshot={snapshot}
				/>
			</div>
		</header>
	);
}

// ---------------------------------------------------------------------------
// Search with typeahead
// ---------------------------------------------------------------------------

function EntryThumb({
	entry,
	snapshot,
}: {
	entry: WikiEntry;
	snapshot: InterfaceSnapshot;
}) {
	const agent =
		entry.kind === "agent" ? wikiAgent(snapshot, entry.id) : undefined;
	if (agent) {
		return <WikiPortrait agent={agent} className="size-8" size={32} />;
	}
	let icon: ReactNode;
	if (entry.kind === "team") {
		icon = <Users className="size-4" strokeWidth={1.75} />;
	} else if (entry.kind === "project") {
		icon = <FolderClosed className="size-4" strokeWidth={1.75} />;
	} else {
		icon = <MessageSquareText className="size-4" strokeWidth={1.75} />;
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-8 shrink-0 items-center justify-center border border-border bg-muted/60 text-muted-foreground"
		>
			{icon}
		</span>
	);
}

function WikiSearch({
	inputRef,
	onSearch,
	snapshot,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	onSearch: (query: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const nav = useWikiNav();
	const reduceMotion = useReducedMotion();
	const listId = useId();
	const wrapperRef = useRef<HTMLFormElement>(null);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const trimmed = query.trim();
	const hits = useMemo(
		() =>
			wikiSuggest(snapshot, trimmed, SUGGESTION_LIMIT).map((entry) => ({
				entry,
			})),
		[snapshot, trimmed]
	);
	// The suggestions, then a final "Search for pages containing" row.
	const optionCount = trimmed ? hits.length + 1 : 0;
	const expanded = open && optionCount > 0;

	useEffect(() => {
		if (!expanded) {
			return;
		}
		const onPointer = (event: PointerEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node | null)) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [expanded]);

	const finish = () => {
		setOpen(false);
		setActive(-1);
		setQuery("");
		inputRef.current?.blur();
	};
	const choose = (index: number) => {
		const hit = hits[index];
		if (hit) {
			nav.go(hit.entry.route);
		} else if (trimmed) {
			onSearch(trimmed);
		}
		finish();
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (active >= 0 && expanded) {
			choose(active);
			return;
		}
		if (trimmed) {
			onSearch(trimmed);
			finish();
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" && optionCount > 0) {
			event.preventDefault();
			setOpen(true);
			setActive((index) => (index + 1) % optionCount);
		} else if (event.key === "ArrowUp" && optionCount > 0) {
			event.preventDefault();
			setOpen(true);
			setActive((index) => (index <= 0 ? optionCount - 1 : index - 1));
		} else if (event.key === "Escape") {
			if (expanded) {
				event.preventDefault();
				setOpen(false);
				setActive(-1);
			} else if (query) {
				event.preventDefault();
				setQuery("");
			}
		}
	};
	const optionId = (index: number) => `${listId}-option-${index}`;

	return (
		<form
			className="relative flex min-w-0 @[1000px]/wiki:max-w-[32rem] flex-1 items-center"
			onSubmit={onSubmit}
			ref={wrapperRef}
			role="search"
		>
			<div className="relative min-w-0 flex-1">
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					strokeWidth={1.75}
				/>
				<input
					aria-activedescendant={
						expanded && active >= 0 ? optionId(active) : undefined
					}
					aria-autocomplete="list"
					aria-controls={listId}
					aria-expanded={expanded}
					aria-label="Search the wiki"
					autoComplete="off"
					className="h-8 w-full rounded-r-none rounded-l-[2px] border border-input bg-background pr-2 pl-8 text-foreground text-sm outline-none transition-colors placeholder:text-muted-foreground hover:border-ring/60 focus:border-ring focus:ring-1 focus:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
					onChange={(event) => {
						setQuery(event.target.value);
						setOpen(true);
						setActive(-1);
					}}
					onFocus={() => setOpen(true)}
					onKeyDown={onKeyDown}
					placeholder="Search the wiki"
					ref={inputRef}
					role="combobox"
					spellCheck={false}
					type="search"
					value={query}
				/>
			</div>
			<button
				className="-ml-px h-8 shrink-0 cursor-pointer rounded-r-[2px] border border-input bg-muted/60 px-3 font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:z-10 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring active:bg-accent"
				type="submit"
			>
				Search
			</button>
			<AnimatePresence>
				{expanded ? (
					<motion.div
						animate={{ opacity: 1 }}
						aria-label="Search suggestions"
						className="absolute top-full right-0 left-0 z-40 mt-1 border border-border bg-popover py-1 text-popover-foreground shadow-md"
						exit={{ opacity: 0 }}
						id={listId}
						initial={{ opacity: 0 }}
						role="listbox"
						transition={reduceMotion ? { duration: 0 } : { duration: 0.1 }}
					>
						{hits.map((hit, index) => (
							<div
								aria-selected={active === index}
								className={cn(
									"flex cursor-pointer items-center gap-3 px-3 py-1.5",
									active === index ? "bg-muted" : "hover:bg-muted/60"
								)}
								id={optionId(index)}
								key={`${hit.entry.kind}-${hit.entry.id}`}
								onClick={() => choose(index)}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setActive(index)}
								role="option"
							>
								<EntryThumb entry={hit.entry} snapshot={snapshot} />
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-foreground text-sm leading-5">
										<Marked query={trimmed} value={hit.entry.title} />
									</span>
									<span className="truncate text-muted-foreground text-xs leading-4">
										{hit.entry.description}
									</span>
								</span>
							</div>
						))}
						<div
							aria-selected={active === hits.length}
							className={cn(
								"mt-1 flex cursor-pointer items-center gap-3 border-border border-t px-3 py-2 text-sm",
								active === hits.length ? "bg-muted" : "hover:bg-muted/60"
							)}
							id={optionId(hits.length)}
							onClick={() => choose(hits.length)}
							onMouseDown={(event) => event.preventDefault()}
							onMouseEnter={() => setActive(hits.length)}
							role="option"
						>
							<span
								aria-hidden="true"
								className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
							>
								<Search className="size-4" strokeWidth={1.75} />
							</span>
							<span className="min-w-0 truncate">
								Search for pages containing{" "}
								<b className="font-semibold">{trimmed}</b>
							</span>
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</form>
	);
}
