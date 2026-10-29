import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { BookDetail } from "./library-detail.tsx";
import {
	type ContinueItem,
	continueReading,
	findBook,
	LIBRARY_VIEW_LABELS,
	type LibraryBook,
	type LibrarySort,
	type LibraryView,
	libraryShelves,
	matchesQuery,
	readingBook,
	sortBooks,
	viewBooks,
} from "./library-model.ts";
import { LibrarySidebar, LibraryTabs } from "./library-nav.tsx";
import { ChapterReader, ownsKeys } from "./library-reader.tsx";
import {
	BookGrid,
	BookTile,
	ContinueShelf,
	LIBRARY_BOOK_ATTRIBUTE,
	LibraryToolbar,
	Shelf,
} from "./library-shelf.tsx";
import {
	LibraryEmpty,
	LibraryNoMatch,
	LibrarySkeleton,
} from "./library-states.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;

/** Wall clock that ticks once a minute so relative ages stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

const VIEW_EMPTY: Record<LibraryView, string> = {
	all: "No books yet.",
	continue:
		"Nothing is waiting on you. Chapters land here when an agent replies or a run fails.",
	finished:
		"No finished books yet. A book is finished when its agent has answered every chapter.",
	home: "No books yet.",
};

/** A page that fades in when it mounts (and only cuts under reduced motion). */
function Page({
	children,
	className,
	pageKey,
}: {
	children: ReactNode;
	className?: string;
	pageKey: string;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className={className}
			data-page={pageKey}
			initial={reduceMotion ? false : { opacity: 0, y: 6 }}
			transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
		>
			{children}
		</motion.div>
	);
}

/**
 * Library: an Apple Books style library over the same agents and threads.
 * Every agent is a book with a generated cover, every project and team a
 * collection, and every conversation a chapter. Home shows Continue Reading
 * (books with chapters waiting on you), the Library grid with search and
 * sort, and Collections. A book opens to its page with the contents; a
 * chapter opens a reading view around the host's real conversation.
 */
export function LibraryInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = useMinuteClock();
	const [view, setView] = useState<LibraryView>("home");
	const [openBookId, setOpenBookId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<LibrarySort>("recent");
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	/** The book control to hand focus back to after leaving a book. */
	const returnFocusId = useRef<string | null>(null);

	const shelves = useMemo(() => libraryShelves(snapshot), [snapshot]);
	const continueItems = useMemo(() => continueReading(shelves), [shelves]);
	const openBook = findBook(shelves, openBookId);
	const reading = threadView !== null;
	const book = reading
		? readingBook(shelves, openBookId, activeThreadId)
		: openBook;
	const counts = useMemo<Record<LibraryView, number>>(
		() => ({
			all: viewBooks(shelves, "all").length,
			continue: viewBooks(shelves, "continue").length,
			finished: viewBooks(shelves, "finished").length,
			home: shelves.books.length,
		}),
		[shelves]
	);
	const isEmpty = snapshot.agents.length === 0 && snapshot.threads.length === 0;

	const showBook = useCallback((bookId: string) => {
		returnFocusId.current = bookId;
		setOpenBookId(bookId);
	}, []);
	const showView = useCallback((next: LibraryView) => {
		returnFocusId.current = null;
		setOpenBookId(null);
		setView(next);
	}, []);
	const leaveBook = useCallback(() => setOpenBookId(null), []);
	const openChapter = useCallback(
		(threadId: string) => port.openThread(threadId),
		[port]
	);
	const continueBook = useCallback(
		(item: ContinueItem) => {
			returnFocusId.current = item.book.id;
			setOpenBookId(item.book.id);
			port.openThread(item.chapter.thread.id);
		},
		[port]
	);
	const bookId = book?.id ?? null;
	const leaveReader = useCallback(() => {
		setOpenBookId(bookId);
		port.closeThread();
	}, [bookId, port]);
	const writeChapter = useCallback(
		(
			target: LibraryBook,
			input: { agentId: string | null; prompt: string }
		) => {
			setOpenBookId(target.id);
			port.startThread({
				...(input.agentId ? { agentId: input.agentId } : {}),
				...(target.kind === "project" && target.groupId
					? { projectId: target.groupId }
					: {}),
				...(target.kind === "team" && target.groupId
					? { teamId: target.groupId }
					: {}),
				prompt: input.prompt,
			});
		},
		[port]
	);

	// Opening a book moves focus to its title; leaving it returns focus to
	// the cover that opened it, so keyboard users keep their place.
	const pageKey = reading
		? "reader"
		: openBook
			? `book:${openBook.id}`
			: `view:${view}`;
	useEffect(() => {
		if (pageKey === "reader") {
			return;
		}
		scrollRef.current?.scrollTo?.({ top: 0 });
		if (pageKey.startsWith("book:")) {
			headingRef.current?.focus({ preventScroll: true });
			return;
		}
		const target = returnFocusId.current;
		returnFocusId.current = null;
		if (!target) {
			return;
		}
		const controls = [
			...(rootRef.current?.querySelectorAll<HTMLElement>(
				`[${LIBRARY_BOOK_ATTRIBUTE}]`
			) ?? []),
		].filter(
			(control) => control.getAttribute(LIBRARY_BOOK_ATTRIBUTE) === target
		);
		// Prefer the shelf tile over a Continue Reading card for the same book.
		const control =
			controls.find((item) => !item.hasAttribute("data-thread-id")) ??
			controls[0];
		control?.focus();
	}, [pageKey]);

	// "/" jumps to search from anywhere on a shelf page.
	const shelfPage = !(reading || openBook);
	useEffect(() => {
		if (!shelfPage) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "/" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target)
			) {
				return;
			}
			event.preventDefault();
			searchRef.current?.focus();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shelfPage]);

	if (reading) {
		return (
			<div
				className="@container/library flex size-full min-h-0 bg-background text-foreground"
				data-testid="interface-library"
				ref={rootRef}
			>
				<Page className="flex size-full min-h-0" key="reader" pageKey="reader">
					<ChapterReader
						book={book}
						now={now}
						onBack={leaveReader}
						onOpenChapter={openChapter}
						threadId={activeThreadId}
						threadView={threadView}
					/>
				</Page>
			</div>
		);
	}

	const toolbar = (
		<LibraryToolbar
			inputRef={searchRef}
			onQuery={setQuery}
			onSort={setSort}
			query={query}
			sort={sort}
		/>
	);
	const clearSearch = () => {
		setQuery("");
		searchRef.current?.focus();
	};

	let content: ReactNode;
	if (loading && isEmpty) {
		content = <LibrarySkeleton />;
	} else if (openBook) {
		content = (
			<BookDetail
				backLabel={LIBRARY_VIEW_LABELS[view]}
				book={openBook}
				headingRef={headingRef}
				now={now}
				onBack={leaveBook}
				onOpenChapter={openChapter}
				onWrite={(input) => writeChapter(openBook, input)}
			/>
		);
	} else if (view === "home") {
		const books = sortBooks(
			shelves.books.filter((item) => matchesQuery(item, query)),
			sort
		);
		const collections = shelves.collections.filter((item) =>
			matchesQuery(item, query)
		);
		const searching = query.trim() !== "";
		content = (
			<div className="flex flex-col gap-12">
				{continueItems.length > 0 && !searching ? (
					<ContinueShelf
						items={continueItems}
						now={now}
						onOpen={continueBook}
					/>
				) : null}
				<Shelf actions={toolbar} title="Library">
					{books.length > 0 ? (
						<BookGrid>
							{books.map((item) => (
								<BookTile book={item} key={item.id} onOpen={showBook} />
							))}
						</BookGrid>
					) : (
						<LibraryNoMatch onClear={clearSearch} query={query} />
					)}
				</Shelf>
				{collections.length > 0 ? (
					<Shelf title="Collections">
						<BookGrid>
							{collections.map((item) => (
								<BookTile book={item} key={item.id} onOpen={showBook} />
							))}
						</BookGrid>
					</Shelf>
				) : null}
			</div>
		);
	} else {
		const listed = viewBooks(shelves, view);
		const books = sortBooks(
			listed.filter((item) => matchesQuery(item, query)),
			sort
		);
		let body: ReactNode;
		if (books.length > 0) {
			body = (
				<BookGrid>
					{books.map((item) => (
						<BookTile book={item} key={item.id} onOpen={showBook} />
					))}
				</BookGrid>
			);
		} else if (listed.length > 0) {
			body = <LibraryNoMatch onClear={clearSearch} query={query} />;
		} else {
			body = (
				<p className="max-w-md py-12 text-muted-foreground text-sm">
					{VIEW_EMPTY[view]}
				</p>
			);
		}
		content = (
			<div className="flex flex-col gap-6">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
					<h1 className="font-semibold text-2xl text-foreground tracking-tight">
						{LIBRARY_VIEW_LABELS[view]}
					</h1>
					{toolbar}
				</div>
				{body}
			</div>
		);
	}

	return (
		<div
			className="@container/library flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-library"
			ref={rootRef}
		>
			{isEmpty && !loading ? (
				<LibraryEmpty onStart={() => port.startThread({})} />
			) : (
				<>
					<LibrarySidebar
						collections={shelves.collections}
						counts={counts}
						onCollection={showBook}
						onView={showView}
						selectedBookId={openBookId}
						view={openBook ? null : view}
					/>
					<div className="flex min-w-0 flex-1 flex-col">
						<LibraryTabs onView={showView} view={openBook ? null : view} />
						<div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
							<Page
								className={
									openBook
										? undefined
										: "mx-auto w-full max-w-[90rem] @3xl/library:px-10 px-4 @3xl/library:pt-8 pt-6 pb-16"
								}
								key={pageKey}
								pageKey={pageKey}
							>
								{view === "home" && !openBook ? (
									<h1 className="sr-only">Library</h1>
								) : null}
								{content}
							</Page>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
