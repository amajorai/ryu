import { translate as tr } from "@ryu/i18n/lite";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { relativeAge } from "./interface-renderer.ts";
import type { QaQuestion, QaTopic } from "./qa-model.ts";

export { QaByline } from "./qa-byline.tsx";

/** Square ghost icon button shared by the top bar, page, and rails. */
export const QA_ICON_BUTTON =
	"flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/** "now", "5m ago", "2h ago", in the UI locale. */
export function qaAgo(iso: string, now: number): string {
	return relativeAge(iso, now);
}

/**
 * A topic tag in Stack Overflow's shape: a small tinted rectangle. Tags are
 * real buttons that narrow the feed to their topic.
 */
export function QaTag({
	onSelect,
	pressed,
	topic,
}: {
	onSelect?: (topic: QaTopic) => void;
	/** Set where the tag toggles a filter, so its state is announced. */
	pressed?: boolean;
	topic: QaTopic;
}) {
	const tl = useLiteralMessages();
	const className =
		"inline-flex h-6 max-w-48 items-center rounded-sm bg-primary/8 px-1.5 font-medium text-primary text-xs leading-none";
	if (!onSelect) {
		return (
			<span className={className}>
				<span className="truncate" data-ryu-i18n="off">
					{topic.name}
				</span>
			</span>
		);
	}
	return (
		<button
			aria-label={tl("Show questions in {topicName}", {
				topicName: topic.name,
			})}
			aria-pressed={pressed}
			className={cn(
				className,
				"relative z-10 outline-none transition-colors duration-100 hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
			)}
			onClick={() => onSelect(topic)}
			type="button"
		>
			<span className="truncate" data-ryu-i18n="off">
				{topic.name}
			</span>
		</button>
	);
}

/**
 * The answers box from Stack Overflow's stats column: plain at zero, outlined
 * once an agent has replied, and filled when the newest reply is waiting on
 * the user.
 */
export function QaAnswerBox({
	compact = false,
	question,
}: {
	compact?: boolean;
	question: QaQuestion;
}) {
	const { answers, status } = question;
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-sm tabular-nums",
				compact && "h-6 min-w-8 justify-center px-1 text-xs",
				answers === 0 && "text-muted-foreground",
				answers > 0 &&
					status !== "your-turn" &&
					"border border-status-success/60 text-status-success",
				status === "your-turn" &&
					answers > 0 &&
					"bg-success font-medium text-success-foreground"
			)}
		>
			{compact ? (
				<>
					<span aria-hidden="true">{answers}</span>
					<span className="sr-only">
						{tr("{count, plural, one {# answer} other {# answers}}", {
							count: answers,
						})}
					</span>
				</>
			) : (
				<>
					<span className="font-medium">{answers}</span>
					{tr("{count, plural, one {answer} other {answers}}", {
						count: answers,
					})}
				</>
			)}
		</span>
	);
}

/** Stats beside a question: answers, messages, and a pinned note. */
export function QaStats({ question }: { question: QaQuestion }) {
	return (
		<div
			className="flex @[640px]/qa:w-24 shrink-0 flex-row @[640px]/qa:flex-col flex-wrap @[640px]/qa:items-end items-center gap-x-3 gap-y-1 text-muted-foreground text-sm"
			data-testid="qa-stats"
		>
			<QaAnswerBox question={question} />
			<span className="flex h-6 items-center whitespace-nowrap @[640px]/qa:px-1.5 tabular-nums">
				<span className="pe-1 font-medium text-foreground">
					{question.thread.messageCount}
				</span>
				{tr("{count, plural, one {message} other {messages}}", {
					count: question.thread.messageCount,
				})}
			</span>
			{question.thread.pinned ? (
				<span className="flex h-6 items-center @[640px]/qa:px-1.5 text-xs">
					Pinned
				</span>
			) : null}
		</div>
	);
}

/** Feed placeholder while the first snapshot loads: rows in the real rhythm. */
export function QaFeedSkeleton() {
	return (
		<div aria-label="Loading questions" className="flex flex-col" role="status">
			{["one", "two", "three", "four", "five"].map((key) => (
				<div
					className="flex @[640px]/qa:gap-6 gap-4 border-border border-b py-4"
					key={key}
				>
					<div className="@[640px]/qa:flex hidden w-24 shrink-0 flex-col items-end gap-2">
						<Skeleton className="h-6 w-20" radius="dense" />
						<Skeleton className="h-4 w-16" radius="dense" />
					</div>
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-5 w-3/5" radius="dense" />
						<Skeleton className="h-4 w-40" radius="dense" />
						<Skeleton className="h-4 w-full" radius="dense" />
						<Skeleton className="h-4 w-4/5" radius="dense" />
					</div>
				</div>
			))}
			<span className="sr-only">Loading questions</span>
		</div>
	);
}

/** A plain empty state: what is missing, why, and one way forward. */
export function QaEmpty({
	action,
	body,
	title,
}: {
	action?: { label: string; onClick: () => void } | null;
	body: string;
	title: string;
}) {
	return (
		<div
			className="flex flex-col items-start gap-1 py-12"
			data-testid="qa-empty"
		>
			<h2 className="font-semibold! text-base text-foreground">{title}</h2>
			<p className="max-w-[46ch] text-muted-foreground text-sm leading-6">
				{body}
			</p>
			{action ? (
				<Button
					className="mt-3"
					onClick={action.onClick}
					size="sm"
					variant="outline"
				>
					{action.label}
				</Button>
			) : null}
		</div>
	);
}
