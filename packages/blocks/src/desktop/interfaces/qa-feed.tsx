import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import type { QaQuestion, QaTopic } from "./qa-model.ts";
import { QaByline, QaStats, QaTag } from "./qa-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface QaQuestionRowProps {
	now: number;
	onOpen: (threadId: string) => void;
	onSelectTopic: (topic: QaTopic) => void;
	question: QaQuestion;
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
}

/**
 * One question summary: Stack Overflow's stats column and title, with the
 * newest answer under it the way Quora shows one. The whole row opens the
 * question; tags stay their own buttons above the row's hit area.
 */
export function QaQuestionRow({
	now,
	onOpen,
	onSelectTopic,
	question,
	registerRow,
}: QaQuestionRowProps) {
	const { excerpt, thread, topics } = question;
	return (
		<article
			className="group/row relative flex @[640px]/qa:flex-row flex-col @[640px]/qa:gap-6 gap-2 border-border border-b py-4"
			data-status={question.status}
			data-thread-id={thread.id}
		>
			<QaStats question={question} />
			<div className="flex min-w-0 flex-1 flex-col">
				<h3 className="min-w-0 text-base leading-6">
					<button
						className="rounded-sm text-left font-medium text-primary outline-none transition-colors duration-100 after:absolute after:inset-0 hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring/50"
						data-row-link=""
						onClick={() => onOpen(thread.id)}
						ref={(element) => registerRow(thread.id, element)}
						type="button"
					>
						{thread.title}
					</button>
				</h3>
				<div className="mt-1">
					<QaByline now={now} question={question} />
				</div>
				{excerpt ? (
					<p
						className={cn(
							"mt-1 line-clamp-2 text-foreground/80 text-sm leading-6",
							question.byline === "asked" && "text-muted-foreground"
						)}
					>
						{excerpt}
					</p>
				) : null}
				{topics.length > 0 ? (
					<ul aria-label="Topics" className="mt-3 flex flex-wrap gap-1.5">
						{topics.map((topic) => (
							<li key={topic.id}>
								<QaTag onSelect={onSelectTopic} topic={topic} />
							</li>
						))}
					</ul>
				) : null}
			</div>
		</article>
	);
}

export interface QaFeedListProps {
	now: number;
	onOpen: (threadId: string) => void;
	onSelectTopic: (topic: QaTopic) => void;
	questions: readonly QaQuestion[];
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
	/** Changes when the tab or filter changes, so the list fades in fresh. */
	viewKey: string;
}

/** Question rows divided by hairlines, no cards. */
export function QaFeedList({
	now,
	onOpen,
	onSelectTopic,
	questions,
	registerRow,
	viewKey,
}: QaFeedListProps) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="flex flex-col border-border border-t"
			data-testid="qa-feed"
			initial={reduceMotion ? false : { opacity: 0 }}
			key={viewKey}
			transition={{ duration: 0.14, ease: "easeOut" }}
		>
			{questions.map((question) => (
				<QaQuestionRow
					key={question.thread.id}
					now={now}
					onOpen={onOpen}
					onSelectTopic={onSelectTopic}
					question={question}
					registerRow={registerRow}
				/>
			))}
		</motion.div>
	);
}
