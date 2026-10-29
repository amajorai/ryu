import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ChevronLeft } from "lucide-react";
import { type RefObject, useId, useRef } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { ChapterComposer } from "./library-composer.tsx";
import { BookCover } from "./library-cover.tsx";
import {
	authorList,
	bookKindLabel,
	chapterCountLabel,
	type LibraryBook,
	type LibraryChapter,
	progressPercent,
	readableAge,
	resumeChapter,
} from "./library-model.ts";
import { ProgressTrack } from "./library-shelf.tsx";

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1 px-4 first:pl-0 last:pr-0">
			<dt className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.1em]">
				{label}
			</dt>
			<dd className="truncate font-semibold text-foreground text-sm tabular-nums">
				{value}
			</dd>
		</div>
	);
}

function statusTone(chapter: LibraryChapter): string {
	if (chapter.status === "attention") {
		return "text-destructive";
	}
	if (chapter.status === "your-turn") {
		return "text-primary";
	}
	if (chapter.status === "working") {
		return "text-foreground";
	}
	return "text-muted-foreground";
}

/** One line in the contents: number, title on a dotted leader, status, age. */
function ContentsRow({
	chapter,
	now,
	onOpen,
}: {
	chapter: LibraryChapter;
	now: number;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const { thread } = chapter;
	const status = THREAD_STATUS_LABELS[chapter.status];
	const age = readableAge(thread.updatedAt, now);
	return (
		<li className="border-border border-b last:border-b-0">
			<button
				aria-label={tl("Chapter {chapterNumber}: {title}. {status}, {age}", {
					age,
					chapterNumber: chapter.number.toString(),
					status,
					title: thread.title,
				})}
				className="group -mx-3 grid w-[calc(100%+1.5rem)] grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-md px-3 py-3 text-left outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
				data-thread-id={thread.id}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="text-muted-foreground text-sm tabular-nums">
					{chapter.number}
				</span>
				<span className="flex min-w-0 items-baseline gap-3">
					<span className="truncate font-medium text-[15px] text-foreground">
						{thread.title}
					</span>
					<span
						aria-hidden="true"
						className="@3xl/library:block hidden min-w-6 flex-1 border-border border-b border-dotted"
					/>
				</span>
				<span className="flex items-center gap-4 text-sm">
					<span
						className={cn(
							"@2xl/library:inline-flex hidden items-center gap-1.5",
							statusTone(chapter)
						)}
					>
						<BoardStatusDot status={chapter.status} />
						{status}
					</span>
					<BoardStatusDot
						className="@2xl/library:hidden"
						status={chapter.status}
					/>
					<span className="w-24 text-right text-muted-foreground tabular-nums">
						{age}
					</span>
				</span>
			</button>
		</li>
	);
}

/** The one line of state beside the author: a failure, a live run, or a turn. */
function authorStatus(
	book: LibraryBook
): { text: string; tone: string } | null {
	const failed = book.waiting.filter(
		(chapter) => chapter.status === "attention"
	).length;
	if (failed > 0) {
		return {
			text: `${THREAD_STATUS_LABELS.attention} in ${chapterCountLabel(failed).toLowerCase()}`,
			tone: "text-destructive",
		};
	}
	if (book.working) {
		return { text: "Writing now", tone: "text-foreground" };
	}
	if (book.waiting.length > 0) {
		return {
			text: `${THREAD_STATUS_LABELS["your-turn"]} in ${chapterCountLabel(book.waiting.length).toLowerCase()}`,
			tone: "text-primary",
		};
	}
	return null;
}

/**
 * A book's page, the way Books shows one: a large cover beside the title,
 * author line, description, actions and an info strip; then the contents,
 * where each conversation is a chapter, and a field to write the next one.
 */
export function BookDetail({
	backLabel,
	book,
	headingRef,
	now,
	onBack,
	onOpenChapter,
	onWrite,
}: {
	backLabel: string;
	book: LibraryBook;
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onBack: () => void;
	onOpenChapter: (threadId: string) => void;
	onWrite: (input: { agentId: string | null; prompt: string }) => void;
}) {
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const contentsId = useId();
	const tl = useLiteralMessages();
	const resume = resumeChapter(book);
	const percent = progressPercent(book);
	const status = authorStatus(book);
	const subject =
		book.kind === "agent"
			? book.title
			: `the ${book.title} ${book.kind === "unassigned" ? "collection" : book.kind}`;
	const writeChapter = () => {
		fieldRef.current?.focus();
		fieldRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
	};

	return (
		<div className="mx-auto w-full max-w-[60rem] @3xl/library:px-10 px-4 @3xl/library:pt-4 pt-3 pb-16">
			<Button
				className="-ml-2 text-muted-foreground"
				onClick={onBack}
				size="sm"
				variant="ghost"
			>
				<ChevronLeft aria-hidden="true" data-icon="inline-start" />
				{backLabel}
			</Button>
			<div className="mt-4 flex @2xl/library:flex-row flex-col @2xl/library:items-start items-center @3xl/library:gap-12 gap-8">
				<div className="@2xl/library:w-48 @5xl/library:w-56 w-40 shrink-0 rounded-[3px] shadow-foreground/20 shadow-lg">
					<BookCover
						authors={book.authors}
						bookId={book.id}
						kind={book.kind}
						subtitle={book.description}
						title={book.title}
					/>
				</div>
				<div className="flex w-full min-w-0 flex-1 flex-col @2xl/library:pt-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]">
						{bookKindLabel(book.kind)}
					</p>
					<h1
						className="mt-2 text-balance font-serif text-4xl text-foreground leading-[1.1] outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{book.title}
					</h1>
					<p className="mt-2 text-base text-muted-foreground">
						by{" "}
						<span className="font-medium text-foreground">
							{authorList(book.authors)}
						</span>
						{status ? (
							<span
								className={cn(
									"ml-2 inline-flex items-center gap-2 text-sm",
									status.tone
								)}
							>
								<span aria-hidden="true" className="text-muted-foreground">
									·
								</span>
								{status.text}
							</span>
						) : null}
					</p>
					{book.description ? (
						<p className="mt-4 max-w-prose text-[15px] text-foreground/80 leading-relaxed">
							{book.description}
						</p>
					) : null}
					<div className="mt-6 flex flex-wrap gap-2">
						{resume ? (
							<Button
								className="min-w-28"
								onClick={() => onOpenChapter(resume.thread.id)}
							>
								{book.waiting.length > 0 ? "Continue" : "Read"}
							</Button>
						) : null}
						<Button onClick={writeChapter} variant="secondary">
							Write a chapter
						</Button>
					</div>
					<dl className="mt-8 grid grid-cols-3 divide-x divide-border border-border border-y py-3">
						<Fact
							label="Length"
							value={chapterCountLabel(book.chapters.length)}
						/>
						<div className="flex min-w-0 flex-col gap-1 px-4">
							<dt className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.1em]">
								Finished
							</dt>
							<dd className="flex items-center gap-2.5 font-semibold text-foreground text-sm tabular-nums">
								{percent}%
								<ProgressTrack
									className="w-full max-w-20 flex-1"
									value={percent}
								/>
							</dd>
						</div>
						<Fact
							label="Updated"
							value={
								book.updatedAt ? readableAge(book.updatedAt, now) : "Never"
							}
						/>
					</dl>
				</div>
			</div>
			<section aria-labelledby={contentsId} className="mt-12">
				<div className="flex items-baseline justify-between border-border border-b pb-3">
					<h2
						className="font-semibold text-foreground text-lg tracking-tight"
						id={contentsId}
					>
						Contents
					</h2>
					<span className="text-muted-foreground text-sm">
						{chapterCountLabel(book.chapters.length)}
					</span>
				</div>
				{book.chapters.length > 0 ? (
					<ol aria-label={tl("{title} chapters", { title: book.title })}>
						{book.chapters.map((chapter) => (
							<ContentsRow
								chapter={chapter}
								key={chapter.thread.id}
								now={now}
								onOpen={onOpenChapter}
							/>
						))}
					</ol>
				) : (
					<p className="py-6 text-muted-foreground text-sm">
						No chapters yet. Write the first one below.
					</p>
				)}
				<div className="mt-6">
					<ChapterComposer
						authors={book.authors}
						chapterNumber={book.chapters.length + 1}
						defaultAgentId={book.agentId}
						fieldRef={fieldRef}
						onSubmit={onWrite}
						subject={subject}
					/>
				</div>
			</section>
		</div>
	);
}
