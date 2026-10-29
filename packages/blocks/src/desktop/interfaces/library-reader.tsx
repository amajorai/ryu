import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight, List } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	type LibraryBook,
	type LibraryChapter,
	neighbours,
	readableAge,
} from "./library-model.ts";
import { ProgressTrack } from "./library-shelf.tsx";

/** Where key presses belong to typing or to the host's conversation. */
export const CHAPTER_BODY_ATTRIBUTE = "data-library-chapter-body";

export function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest(`[${CHAPTER_BODY_ATTRIBUTE}]`) !== null
	);
}

/** The book's contents in a popover, for jumping between chapters. */
function ContentsMenu({
	book,
	currentId,
	onOpenChapter,
}: {
	book: LibraryBook;
	currentId: string | null;
	onOpenChapter: (threadId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				aria-label="Contents"
				className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground motion-reduce:transition-none"
				type="button"
			>
				<List aria-hidden="true" className="size-4" strokeWidth={1.75} />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 max-w-[calc(100vw-2rem)]"
				corners="rounded"
				sideOffset={6}
				spacing="dense-menu"
			>
				<p className="px-2.5 pt-1.5 pb-2 font-serif text-base text-foreground">
					{book.title}
				</p>
				<ol className="flex max-h-80 flex-col gap-px overflow-y-auto">
					{book.chapters.map((chapter) => {
						const current = chapter.thread.id === currentId;
						return (
							<li key={chapter.thread.id}>
								<button
									aria-current={current ? "page" : undefined}
									className={cn(
										"grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
										current && "bg-muted"
									)}
									onClick={() => {
										setOpen(false);
										onOpenChapter(chapter.thread.id);
									}}
									type="button"
								>
									<span className="text-muted-foreground tabular-nums">
										{chapter.number}
									</span>
									<span
										className={cn(
											"truncate",
											current
												? "font-medium text-foreground"
												: "text-foreground"
										)}
									>
										{chapter.thread.title}
									</span>
									<BoardStatusDot status={chapter.status} />
								</button>
							</li>
						);
					})}
				</ol>
			</PopoverContent>
		</Popover>
	);
}

function turnChapterLabel(
	tl: LiteralMessage,
	direction: "next" | "previous",
	title: string
): string {
	return direction === "next"
		? tl("Next chapter: {title}", { title })
		: tl("Previous chapter: {title}", { title });
}

function noTurnChapterLabel(
	tl: LiteralMessage,
	direction: "next" | "previous"
): string {
	return direction === "next"
		? tl("No next chapter")
		: tl("No previous chapter");
}

function TurnButton({
	chapter,
	direction,
	onOpen,
}: {
	chapter: LibraryChapter | undefined;
	direction: "next" | "previous";
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const label = direction === "next" ? "Next" : "Previous";
	const Icon = direction === "next" ? ChevronRight : ChevronLeft;
	return (
		<Button
			aria-label={
				chapter
					? turnChapterLabel(tl, direction, chapter.thread.title)
					: noTurnChapterLabel(tl, direction)
			}
			className={cn(
				"h-10 min-w-0 max-w-full gap-2 px-2.5",
				direction === "next" ? "justify-self-end" : "justify-self-start"
			)}
			disabled={!chapter}
			onClick={() => (chapter ? onOpen(chapter.thread.id) : undefined)}
			variant="ghost"
		>
			{direction === "previous" ? (
				<Icon aria-hidden="true" className="size-4" />
			) : null}
			<span
				className={cn(
					"flex min-w-0 flex-col leading-tight",
					direction === "next" ? "items-end text-right" : "items-start"
				)}
			>
				<span className="text-[11px] text-muted-foreground uppercase tracking-[0.1em]">
					{label}
				</span>
				{chapter ? (
					<span className="@2xl/library:block hidden max-w-56 truncate font-serif text-sm">
						{chapter.thread.title}
					</span>
				) : null}
			</span>
			{direction === "next" ? (
				<Icon aria-hidden="true" className="size-4" />
			) : null}
		</Button>
	);
}

/**
 * The reading view: book chrome around the host's real conversation. A thin
 * top bar (back, contents, the book's title in reading type), a chapter
 * opening with page margins, the conversation as the chapter body, and page
 * turns to the chapters either side.
 */
export function ChapterReader({
	book,
	now,
	onBack,
	onOpenChapter,
	threadId,
	threadView,
}: {
	book: LibraryBook | undefined;
	now: number;
	onBack: () => void;
	onOpenChapter: (threadId: string) => void;
	threadId: string | null;
	threadView: ReactNode;
}) {
	const { current, next, previous } = neighbours(book, threadId);
	const total = book?.chapters.length ?? 0;
	const position = current ? current.number : total + 1;
	const rootRef = useRef<HTMLElement>(null);
	const tl = useLiteralMessages();

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				isInterfaceCovered(rootRef.current) ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target)
			) {
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				onBack();
			} else if (event.key === "ArrowLeft" && previous) {
				event.preventDefault();
				onOpenChapter(previous.thread.id);
			} else if (event.key === "ArrowRight" && next) {
				event.preventDefault();
				onOpenChapter(next.thread.id);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [next, onBack, onOpenChapter, previous]);

	const title = current?.thread.title ?? "New chapter";
	const meta = current
		? `${THREAD_STATUS_LABELS[current.status]} · ${readableAge(current.thread.updatedAt, now)}`
		: "Just started";

	return (
		<article
			aria-label={`${book?.title ?? "Library"}, ${title}`}
			className="flex size-full min-h-0 flex-col bg-background"
			data-testid="library-reader"
			ref={rootRef}
		>
			<header className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-border border-b @3xl/library:px-3 px-2">
				<div className="flex items-center gap-1">
					<Button
						aria-label={
							book
								? tl("Back to {title}", { title: book.title })
								: "Back to library"
						}
						className="text-muted-foreground"
						onClick={onBack}
						size="icon-sm"
						variant="ghost"
					>
						<ChevronLeft aria-hidden="true" />
					</Button>
					{book && book.chapters.length > 0 ? (
						<ContentsMenu
							book={book}
							currentId={current?.thread.id ?? null}
							onOpenChapter={onOpenChapter}
						/>
					) : null}
				</div>
				<p className="max-w-[40vw] truncate text-center font-serif text-muted-foreground text-sm">
					{book?.title ?? "Library"}
				</p>
				<span aria-hidden="true" />
			</header>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="mx-auto w-full max-w-3xl @3xl/library:px-12 px-6 @3xl/library:pt-10 pt-8 pb-5 text-center">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.2em]">
						{tl("Chapter {position}", { position: position.toString() })}
					</p>
					<h1 className="mt-3 text-balance font-serif @3xl/library:text-[1.75rem] text-2xl text-foreground leading-tight">
						{title}
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">{meta}</p>
					<span
						aria-hidden="true"
						className="mx-auto mt-5 block h-px w-12 bg-border"
					/>
				</div>
				<div
					{...{ [CHAPTER_BODY_ATTRIBUTE]: "" }}
					className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col @3xl/library:px-6 px-2"
					data-testid="library-chapter-body"
				>
					{threadView}
				</div>
			</div>
			<footer className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-border border-t @3xl/library:px-3 px-2">
				<TurnButton
					chapter={previous}
					direction="previous"
					onOpen={onOpenChapter}
				/>
				<div className="flex items-center gap-3">
					<ProgressTrack
						className="@2xl/library:block hidden w-32"
						value={total > 0 && current ? (position / total) * 100 : 0}
					/>
					<span className="text-muted-foreground text-xs tabular-nums">
						{total > 0 && current
							? tl("Chapter {position} of {total}", {
									position: position.toString(),
									total: total.toString(),
								})
							: "New chapter"}
					</span>
				</div>
				<TurnButton chapter={next} direction="next" onOpen={onOpenChapter} />
			</footer>
		</article>
	);
}
