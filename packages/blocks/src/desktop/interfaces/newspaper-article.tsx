import { motion } from "motion/react";
import { type ReactNode, type RefObject, useId } from "react";
import { NewspaperArticleMasthead } from "./newspaper-masthead.tsx";
import { countLabel, type NewspaperStory } from "./newspaper-model.ts";
import {
	BoxHead,
	StoryByline,
	StoryHeadline,
	StoryKicker,
} from "./newspaper-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** Stories the article page's rail offers next. */
const RAIL_LIMIT = 6;

/**
 * An open story: the slim masthead, the story's kicker, headline, and byline,
 * then the host's own conversation surface as the article body. A rail of
 * today's other headlines sits beside it on wide screens.
 */
export function NewspaperArticle({
	headingRef,
	now,
	onBack,
	onOpen,
	others,
	story,
	threadRef,
	threadView,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onBack: () => void;
	onOpen: (threadId: string) => void;
	/** Today's other stories, in news order. */
	others: NewspaperStory[];
	/** Undefined for a thread the snapshot does not list yet. */
	story: NewspaperStory | undefined;
	threadRef: RefObject<HTMLDivElement | null>;
	threadView: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	const headlineId = useId();
	const railId = useId();
	const rail = others.slice(0, RAIL_LIMIT);
	return (
		<div className="flex size-full min-h-0 flex-col">
			<NewspaperArticleMasthead now={now} onBack={onBack} />
			<motion.div
				animate={{ opacity: 1, y: 0 }}
				className="mx-auto flex min-h-0 w-full max-w-[76rem] flex-1"
				initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
				key={story?.thread.id ?? "new"}
				transition={{ duration: reduceMotion ? 0.1 : 0.22, ease: "easeOut" }}
			>
				<article
					aria-labelledby={headlineId}
					className="flex min-h-0 min-w-0 flex-1 flex-col px-4 sm:px-6 lg:px-8"
					data-testid="newspaper-article"
				>
					<header className="mx-auto w-full max-w-3xl shrink-0 border-border border-b pt-8 pb-6">
						{story ? <StoryKicker story={story} /> : null}
						<h1
							className="mt-3 text-balance text-3xl text-foreground leading-[1.15] tracking-[-0.015em] outline-none sm:text-4xl"
							id={headlineId}
							ref={headingRef}
							tabIndex={-1}
						>
							<span className="font-semibold font-serif">
								{story?.thread.title ?? "New story"}
							</span>
						</h1>
						{story ? (
							<StoryByline
								className="mt-4"
								detail={countLabel(story.thread.messageCount, "message")}
								now={now}
								story={story}
							/>
						) : (
							<p className="mt-4 text-muted-foreground text-xs leading-4">
								Filed just now
							</p>
						)}
					</header>
					<div
						className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-hidden"
						data-testid="newspaper-thread"
						ref={threadRef}
					>
						{threadView}
					</div>
				</article>
				{rail.length > 0 ? (
					<aside
						aria-labelledby={railId}
						className="w-72 shrink-0 overflow-y-auto border-border border-l px-6 pt-8 pb-8 max-xl:hidden"
					>
						<BoxHead id={railId}>More in today’s paper</BoxHead>
						<ul>
							{rail.map((item) => (
								<li
									className="group/story relative border-border border-t py-3 first:border-t-0 first:pt-0"
									key={item.thread.id}
								>
									<StoryKicker showSection={false} story={item} />
									<StoryHeadline
										className="mt-1.5 text-base leading-[1.3]"
										onOpen={onOpen}
										story={item}
									/>
								</li>
							))}
						</ul>
					</aside>
				) : null}
			</motion.div>
		</div>
	);
}
