import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { BookCover } from "./library-cover.tsx";

const PREVIEW_BOOKS = [
	{ id: "library-empty-a", subtitle: "Research", title: "Notes" },
	{ id: "library-empty-b", subtitle: "Design", title: "Drafts" },
	{ id: "library-empty-c", subtitle: "Engineering", title: "Builds" },
] as const;

/** No agents and no conversations: three sample spines and one action. */
export function LibraryEmpty({ onStart }: { onStart: () => void }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
			<div aria-hidden="true" className="flex items-end gap-3">
				{PREVIEW_BOOKS.map((book, index) => (
					<div
						className={
							index === 1
								? "w-20 rounded-[3px] shadow-foreground/15 shadow-md"
								: "w-16 rounded-[3px] opacity-80 shadow-foreground/10 shadow-sm"
						}
						key={book.id}
					>
						<BookCover
							bookId={book.id}
							kind="agent"
							subtitle={book.subtitle}
							title={book.title}
						/>
					</div>
				))}
			</div>
			<h2 className="mt-8 font-semibold text-base text-foreground">
				Your library is empty
			</h2>
			<p className="mt-1.5 max-w-xs text-balance text-muted-foreground text-sm">
				Each agent becomes a book here, and each conversation a chapter.
			</p>
			<Button className="mt-6" onClick={onStart}>
				Start a conversation
			</Button>
		</div>
	);
}

/** Books exist but the search hides all of them. */
export function LibraryNoMatch({
	onClear,
	query,
}: {
	onClear: () => void;
	query: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col items-center py-16 text-center">
			<p className="font-medium text-foreground text-sm">No books found</p>
			<p className="mt-1 max-w-sm text-balance text-muted-foreground text-sm">
				{tl("Nothing in your library matches “{query}”.", {
					query: query.trim(),
				})}
			</p>
			<Button className="mt-4" onClick={onClear} size="sm" variant="secondary">
				Clear search
			</Button>
		</div>
	);
}

const SKELETON_BOOKS = ["a", "b", "c", "d", "e", "f"] as const;
const SKELETON_CARDS = ["a", "b", "c"] as const;

/** The first load: the same shelves and rhythm as the real page. */
export function LibrarySkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading library"
			className="flex flex-col gap-10"
			role="status"
		>
			<div>
				<Skeleton className="h-5 w-40" radius="dense" />
				<div className="mt-5 flex gap-4 overflow-hidden">
					{SKELETON_CARDS.map((key) => (
						<div className="flex w-72 shrink-0 gap-4 p-2" key={key}>
							<Skeleton className="aspect-[2/3] w-[4.5rem]" radius="block" />
							<div className="flex flex-1 flex-col gap-2 pt-1">
								<Skeleton className="h-3 w-20" radius="dense" />
								<Skeleton className="h-4 w-full" radius="dense" />
								<Skeleton className="h-3 w-24" radius="dense" />
							</div>
						</div>
					))}
				</div>
			</div>
			<div>
				<Skeleton className="h-5 w-24" radius="dense" />
				<ul className="mt-5 grid @3xl/library:grid-cols-[repeat(auto-fill,minmax(124px,1fr))] grid-cols-[repeat(auto-fill,minmax(96px,1fr))] @3xl/library:gap-x-6 gap-x-4 gap-y-8">
					{SKELETON_BOOKS.map((key) => (
						<li className="flex flex-col gap-3" key={key}>
							<Skeleton className="aspect-[2/3] w-full" radius="block" />
							<Skeleton className="h-[3px] w-full" radius="pill" />
							<Skeleton className="h-3 w-16" radius="dense" />
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
