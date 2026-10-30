import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type ReactNode, useMemo } from "react";
import {
	agentLeadIntro,
	byRecency,
	didYouKnow,
	eventOutcome,
	eventsOnDay,
	featuredAgent,
	newsItem,
	wikiAgentArticle,
	wikiAgo,
	wikiMonthDay,
	wikiThreadTitle,
	wikiTime,
} from "./wiki-model.ts";
import { Dot, LIST } from "./wiki-pages-marks.tsx";
import { TopicForm } from "./wiki-pages-talk.tsx";
import {
	PROSE,
	WikiFooter,
	WikiLink,
	WikiPortrait,
	WikiText,
} from "./wiki-parts.tsx";

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function Panel({
	children,
	footer,
	title,
	tone,
}: {
	children: ReactNode;
	footer?: ReactNode;
	title: string;
	tone: "lead" | "side";
}) {
	return (
		<section aria-label={title} className="border border-border">
			<h2
				className={cn(
					"border-border border-b px-3 py-1 font-semibold font-serif text-[17px] leading-7",
					tone === "lead" ? "bg-primary/10" : "bg-muted/70"
				)}
			>
				{title}
			</h2>
			<div className="px-3 pt-2 pb-3">
				{children}
				{footer ? (
					<p className="mt-2 text-right text-[13px] leading-5">{footer}</p>
				) : null}
			</div>
		</section>
	);
}

export function MainPage({
	now,
	onStart,
	snapshot,
}: {
	now: number;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const featured = featuredAgent(snapshot);
	const latestThread = featured?.threads[0];
	const news = useMemo(
		() => [...snapshot.threads].sort(byRecency).slice(0, 5),
		[snapshot.threads]
	);
	const ongoing = snapshot.threads
		.filter((thread) => thread.running)
		.sort(byRecency);
	const facts = didYouKnow(snapshot);
	const today = eventsOnDay(snapshot, now);
	const teams = snapshot.groups.filter((group) => group.kind === "team").length;
	const projects = snapshot.groups.length - teams;
	const empty = snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const recentlyFeatured = featured
		? snapshot.agents
				.filter((agent) => agent.id !== featured.agent.id)
				.map((agent) => wikiAgentArticle(snapshot, agent.id))
				.filter((article) => article !== null && article.threads.length > 0)
				.sort((a, b) => (b?.threads.length ?? 0) - (a?.threads.length ?? 0))
				.slice(0, 3)
		: [];

	return (
		<div className="pt-4">
			<section className="border border-border bg-muted/40 px-4 py-5 text-center">
				<h1 className="font-normal font-serif text-[28px] leading-9">
					Welcome to the wiki,
				</h1>
				<p className="mt-1 text-sm leading-6">
					the encyclopedia of this workspace&rsquo;s agents, teams, projects and
					threads.
				</p>
				<p className="mt-2 text-[13px] text-muted-foreground leading-5">
					<WikiLink route={{ index: "agents", kind: "index" }}>
						{tally(snapshot.agents.length, "agent")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "teams", kind: "index" }}>
						{tally(teams, "team")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "projects", kind: "index" }}>
						{tally(projects, "project")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "threads", kind: "index" }}>
						{tally(snapshot.threads.length, "thread")}
					</WikiLink>
				</p>
			</section>

			{empty ? (
				<div className="mt-6 max-w-2xl">
					<h2 className="border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
						This wiki has no pages yet
					</h2>
					<p className={`${PROSE} mt-2`}>
						Pages are written from your workspace: every agent, team, project
						and thread gets an article. Start the first thread here and it will
						appear on this page.
					</p>
					<TopicForm
						agents={snapshot.agents}
						className="mt-4"
						label="First message"
						onSubmit={onStart}
						placeholder="What should an agent work on?"
						submitLabel="Start thread"
					/>
				</div>
			) : (
				<div className="mt-4 grid @3xl/article:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] gap-4">
					<div className="flex min-w-0 flex-col gap-4">
						<Panel
							footer={
								<WikiLink route={{ index: "agents", kind: "index" }}>
									More agents
								</WikiLink>
							}
							title="From today’s featured article"
							tone="lead"
						>
							{featured ? (
								<>
									<WikiPortrait
										agent={featured.agent}
										className="float-left mt-1 mr-3 mb-1 border border-border"
										size={96}
									/>
									<p className={PROSE}>
										<WikiText segments={agentLeadIntro(featured)} />{" "}
										{latestThread
											? tlRich(
													"Its most recent thread is <link>{title}</link>, updated {ago}.",
													{
														ago: wikiAgo(latestThread.updatedAt, now),
														title: wikiThreadTitle(latestThread),
													},
													{
														link: (chunks) => (
															<WikiLink
																route={{ id: latestThread.id, kind: "thread" }}
															>
																{chunks}
															</WikiLink>
														),
													}
												)
											: null}{" "}
										(
										<WikiLink
											bold
											route={{ id: featured.agent.id, kind: "agent" }}
										>
											Full article&hellip;
										</WikiLink>
										)
									</p>
									{recentlyFeatured.length > 0 ? (
										<p className="clear-both pt-2 text-[13px] leading-5">
											{tl("Recently featured:")}{" "}
											{recentlyFeatured.map((article, index) =>
												article ? (
													<span key={article.agent.id}>
														{index > 0 ? <Dot /> : null}
														<WikiLink
															route={{ id: article.agent.id, kind: "agent" }}
														>
															{article.agent.name}
														</WikiLink>
													</span>
												) : null
											)}
										</p>
									) : null}
								</>
							) : (
								<p className={PROSE}>No agents yet.</p>
							)}
						</Panel>
						{facts.length > 0 ? (
							<Panel title="Did you know ..." tone="lead">
								<ul className={LIST}>
									{facts.map((fact) => (
										<li key={fact.map((segment) => segment.text).join("")}>
											<WikiText segments={fact} />
										</li>
									))}
								</ul>
							</Panel>
						) : null}
					</div>
					<div className="flex min-w-0 flex-col gap-4">
						<Panel
							footer={
								<WikiLink route={{ kind: "changes" }}>Recent changes</WikiLink>
							}
							title="In the news"
							tone="side"
						>
							{news.length > 0 ? (
								<ul className={LIST}>
									{news.map((thread) => (
										<li key={thread.id}>
											<WikiText segments={newsItem(snapshot, thread)} />
										</li>
									))}
								</ul>
							) : (
								<p className={PROSE}>No threads yet.</p>
							)}
							{ongoing.length > 0 ? (
								<p className="mt-2 border-border border-t pt-2 text-[13px] leading-5">
									<b className="font-semibold">Ongoing:</b>{" "}
									{ongoing.map((thread, index) => (
										<span key={thread.id}>
											{index > 0 ? <Dot /> : null}
											<WikiLink route={{ id: thread.id, kind: "thread" }}>
												{wikiThreadTitle(thread)}
											</WikiLink>
										</span>
									))}
								</p>
							) : null}
						</Panel>
						{today.length > 0 ? (
							<Panel title="On this day" tone="side">
								<p className="mb-2 font-semibold text-sm leading-6">
									{wikiMonthDay(now)}
								</p>
								<ul className={LIST}>
									{today.map(({ agent, event }) => (
										<li key={event.id}>
											<b className="font-semibold tabular-nums">
												{wikiTime(event.start)}
											</b>{" "}
											&ndash; {event.title}
											{agent ? (
												<>
													{" "}
													for{" "}
													<WikiLink route={{ id: agent.id, kind: "agent" }}>
														{agent.name}
													</WikiLink>
												</>
											) : null}
											<span className="text-muted-foreground">
												{" "}
												({eventOutcome(event)})
											</span>
										</li>
									))}
								</ul>
							</Panel>
						) : null}
					</div>
				</div>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

/** Digits for stat lines ("6 agents"), where prose would spell them out. */
function tally(count: number, noun: string): string {
	return `${count.toLocaleString("en")} ${count === 1 ? noun : `${noun}s`}`;
}
