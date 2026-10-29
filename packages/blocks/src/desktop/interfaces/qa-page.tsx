import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ArrowLeft } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useId } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { QaFacepile } from "./qa-avatar.tsx";
import {
	type QaQuestion,
	type QaTopic,
	qaAbsoluteTime,
	qaNames,
} from "./qa-model.ts";
import { QaAnswerBox, QaTag, qaAgo } from "./qa-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

function Meta({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="flex h-6 min-w-0 items-center gap-1.5">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 items-center gap-1.5 text-foreground">
				{children}
			</dd>
		</div>
	);
}

export interface QaRelatedProps {
	onOpen: (threadId: string) => void;
	questions: readonly QaQuestion[];
}

/** Stack Overflow's Related list: an answers box, then the linked title. */
export function QaRelated({ onOpen, questions }: QaRelatedProps) {
	const headingId = useId();
	return (
		<aside
			aria-labelledby={headingId}
			className="@[1000px]/qa:block hidden w-[288px] shrink-0 overflow-y-auto border-border border-l py-6 pl-6"
			data-testid="qa-related"
		>
			<h2
				className="pb-3 font-semibold! text-foreground text-sm leading-6"
				id={headingId}
			>
				Related questions
			</h2>
			{questions.length === 0 ? (
				<p className="text-muted-foreground text-sm leading-6">
					Questions that share an agent or topic show up here.
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{questions.map((question) => (
						<li className="flex items-start gap-2.5" key={question.thread.id}>
							<QaAnswerBox compact question={question} />
							<button
								className="min-w-0 rounded-sm text-left text-primary text-sm leading-6 outline-none transition-colors duration-100 hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring/50"
								onClick={() => onOpen(question.thread.id)}
								type="button"
							>
								{question.thread.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</aside>
	);
}

export interface QaQuestionPageProps {
	now: number;
	onBack: () => void;
	onOpen: (threadId: string) => void;
	onSelectTopic: (topic: QaTopic) => void;
	/** Null while the host has not listed the thread yet (a new question). */
	question: QaQuestion | null;
	ref?: Ref<HTMLElement>;
	related: readonly QaQuestion[];
	threadView: ReactNode;
}

/**
 * A question's own page: title, who asked and when, its topics, then the
 * host's real conversation as the answers, with related questions beside it.
 */
export function QaQuestionPage({
	now,
	onBack,
	onOpen,
	onSelectTopic,
	question,
	ref,
	related,
	threadView,
}: QaQuestionPageProps) {
	const reduceMotion = useReducedMotion();
	const headingId = useId();
	const thread = question?.thread;
	const showStatus =
		question?.status === "working" || question?.status === "attention";
	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-labelledby={headingId}
			className="flex min-h-0 flex-1 flex-col outline-none"
			data-testid="qa-page"
			initial={reduceMotion ? false : { opacity: 0 }}
			ref={ref}
			tabIndex={-1}
			transition={{ duration: 0.14, ease: "easeOut" }}
		>
			<div className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col @[640px]/qa:px-6 px-4">
				<header className="shrink-0 border-border border-b pt-4 pb-4">
					<Button
						className="-ml-2"
						onClick={onBack}
						size="dense"
						variant="ghost-muted"
					>
						<ArrowLeft aria-hidden="true" data-icon="inline-start" />
						All questions
					</Button>
					<h1
						className="mt-2 font-semibold! text-foreground text-xl leading-7 tracking-tight"
						id={headingId}
					>
						{thread?.title ?? "New question"}
					</h1>
					{question && thread ? (
						<dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
							<Meta label="Asked by">You</Meta>
							<Meta label="Active">
								<time
									dateTime={thread.updatedAt}
									title={qaAbsoluteTime(thread.updatedAt)}
								>
									{qaAgo(thread.updatedAt, now)}
								</time>
							</Meta>
							<Meta label="Answers">
								<span className="tabular-nums">{question.answers}</span>
							</Meta>
							{question.answerers.length > 0 ? (
								<Meta label="Answered by">
									<QaFacepile agents={question.answerers} size={16} />
									<span className="truncate">
										{qaNames(question.answerers)}
									</span>
								</Meta>
							) : null}
							{showStatus ? (
								<Meta label="Status">
									<BoardStatusDot status={question.status} />
									<span
										className={cn(
											question.status === "attention" &&
												"text-status-destructive"
										)}
									>
										{THREAD_STATUS_LABELS[question.status]}
									</span>
								</Meta>
							) : null}
						</dl>
					) : null}
					{question && question.topics.length > 0 ? (
						<ul aria-label="Topics" className="mt-3 flex flex-wrap gap-1.5">
							{question.topics.map((topic) => (
								<li key={topic.id}>
									<QaTag onSelect={onSelectTopic} topic={topic} />
								</li>
							))}
						</ul>
					) : null}
				</header>
				<div className="flex min-h-0 flex-1">
					<div
						aria-label="Answers"
						className="flex min-h-0 min-w-0 flex-1 flex-col"
						data-testid="qa-thread-view"
						role="region"
					>
						{threadView}
					</div>
					<QaRelated onOpen={onOpen} questions={related} />
				</div>
			</div>
		</motion.section>
	);
}
