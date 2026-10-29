import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useId } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { QaAvatar } from "./qa-avatar.tsx";
import type { QaAnswerer, QaTopic, QaTopicCount } from "./qa-model.ts";
import { QaTag } from "./qa-parts.tsx";

export interface QaRailProps {
	agentId: string | null;
	answerers: readonly QaAnswerer[];
	onSelectAgent: (agentId: string) => void;
	onSelectTopic: (topic: QaTopic) => void;
	topicId: string | null;
	topics: readonly QaTopicCount[];
}

function RailHeading({ children, id }: { children: string; id: string }) {
	return (
		<h2
			className="pb-2 font-semibold! text-foreground text-sm leading-6"
			id={id}
		>
			{children}
		</h2>
	);
}

/**
 * The feed's right rail: agents ranked by how much they have answered, then
 * the topics questions are filed under, Stack Overflow's "tag × count" list.
 */
export function QaRail({
	agentId,
	answerers,
	onSelectAgent,
	onSelectTopic,
	topicId,
	topics,
}: QaRailProps) {
	const tl = useLiteralMessages();
	const answerersId = useId();
	const topicsId = useId();
	return (
		<aside
			aria-label="Top answerers and topics"
			className="flex w-[264px] shrink-0 flex-col gap-8 pt-6 pb-16"
			data-testid="qa-rail"
		>
			<section aria-labelledby={answerersId}>
				<RailHeading id={answerersId}>Top answerers</RailHeading>
				{answerers.length === 0 ? (
					<p className="text-muted-foreground text-sm leading-6">
						Agents show up here once they answer.
					</p>
				) : (
					<ol className="-mx-2 flex flex-col">
						{answerers.map((entry) => {
							const selected = entry.agent.id === agentId;
							const working = entry.agent.status === "working";
							return (
								<li key={entry.agent.id}>
									<button
										aria-label={
											working
												? tl("{agentName}, {answers} answers, working", {
														agentName: entry.agent.name,
														answers: String(entry.answers),
													})
												: tl("{agentName}, {answers} answers", {
														agentName: entry.agent.name,
														answers: String(entry.answers),
													})
										}
										aria-pressed={selected}
										className={cn(
											"flex h-12 w-full items-center gap-3 rounded-md px-2 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
											selected && "bg-muted"
										)}
										onClick={() => onSelectAgent(entry.agent.id)}
										type="button"
									>
										<QaAvatar agent={entry.agent} size={32} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground text-sm leading-5">
												<span className="truncate">{entry.agent.name}</span>
												{working ? <BoardStatusDot status="working" /> : null}
											</span>
											<span className="truncate text-muted-foreground text-xs leading-4">
												{entry.agent.description || "Agent"}
											</span>
										</span>
										<span className="shrink-0 text-right text-muted-foreground text-xs tabular-nums leading-4">
											<span className="block font-medium text-foreground text-sm leading-5">
												{entry.answers}
											</span>
											answers
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				)}
			</section>
			{topics.length > 0 ? (
				<section aria-labelledby={topicsId}>
					<RailHeading id={topicsId}>Topics</RailHeading>
					<ul className="flex flex-col gap-2">
						{topics.map((entry) => (
							<li className="flex items-center gap-2" key={entry.topic.id}>
								<QaTag
									onSelect={onSelectTopic}
									pressed={entry.topic.id === topicId}
									topic={entry.topic}
								/>
								<span className="text-muted-foreground text-xs tabular-nums">
									<span aria-hidden="true">× </span>
									{entry.count}
									<span className="sr-only">
										{entry.count === 1 ? " question" : " questions"}
									</span>
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</aside>
	);
}
