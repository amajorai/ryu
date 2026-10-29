import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { QaAsk } from "./qa-ask.tsx";
import { QaFeedList } from "./qa-feed.tsx";
import { QaFeedHeading, QaTabs, QaTopBar } from "./qa-header.tsx";
import {
	EMPTY_QA_FILTER,
	emptyQaDraft,
	type QaDraft,
	type QaFilter,
	type QaTab,
	type QaTopic,
	qaAllQuestions,
	qaCount,
	qaFeed,
	qaHeading,
	qaRelated,
	qaStartInput,
	qaStep,
	qaTabCounts,
	qaTopAnswerers,
	qaTopicCounts,
} from "./qa-model.ts";
import { QaQuestionPage } from "./qa-page.tsx";
import { QaEmpty, QaFeedSkeleton } from "./qa-parts.tsx";
import { QaRail } from "./qa-rail.tsx";

const MINUTE = 60_000;

function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** True for targets whose keys belong to typing, menus, or the host's chat. */
function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[role='menu']") !== null ||
		target.closest("[role='tablist']") !== null ||
		target.closest("[data-testid='qa-thread-view']") !== null
	);
}

const STEP_KEYS: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

interface EmptyCopy {
	action: "ask" | "clear" | null;
	body: string;
	title: string;
}

const TAB_EMPTY: Record<Exclude<QaTab, "top">, EmptyCopy> = {
	answered: {
		action: null,
		body: "When an agent replies and the next move is yours, the question shows up here.",
		title: "No answers waiting on you",
	},
	attention: {
		action: null,
		body: "Questions whose last run failed or was interrupted show up here.",
		title: "Nothing needs attention",
	},
	unanswered: {
		action: null,
		body: "Questions waiting on an agent, or not started yet, show up here.",
		title: "Every question has an answer",
	},
};

/**
 * Q&A: a Stack Overflow style question board over the user's threads. Each
 * thread is a question, its agent replies are the answers, and its project
 * or team is the topic tag. The feed filters by Top, Unanswered, Answered,
 * and Needs attention; a question opens as a page whose answers are the
 * host's real conversation, with related questions beside it.
 */
export function QaInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const pageRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowElements = useRef(new Map<string, HTMLButtonElement>());
	const lastOpenedId = useRef<string | null>(null);
	const tabsId = useId();
	const panelId = `${tabsId}-panel`;
	const idFor = useCallback((tab: QaTab) => `${tabsId}-${tab}`, [tabsId]);
	const now = useMinuteClock();

	const [filter, setFilter] = useState<QaFilter>(EMPTY_QA_FILTER);
	const [asking, setAsking] = useState(false);
	const [draft, setDraft] = useState<QaDraft>(() => emptyQaDraft());

	const questions = useMemo(() => qaAllQuestions(snapshot), [snapshot]);
	const feed = useMemo(() => qaFeed(questions, filter), [questions, filter]);
	const counts = useMemo(
		() => qaTabCounts(questions, filter),
		[questions, filter]
	);
	const answerers = useMemo(() => qaTopAnswerers(snapshot), [snapshot]);
	const topics = useMemo(() => qaTopicCounts(snapshot), [snapshot]);

	const pageOpen = threadView !== null && threadView !== undefined;
	const activeQuestion =
		questions.find((question) => question.thread.id === activeThreadId) ?? null;
	const related = useMemo(
		() => (activeThreadId ? qaRelated(snapshot, activeThreadId) : []),
		[snapshot, activeThreadId]
	);

	useEffect(() => {
		if (activeThreadId) {
			lastOpenedId.current = activeThreadId;
		}
	}, [activeThreadId]);

	// Into the page when a question opens; back to its row when it closes.
	useEffect(() => {
		if (pageOpen) {
			pageRef.current?.focus({ preventScroll: true });
			return;
		}
		const id = lastOpenedId.current;
		if (id) {
			lastOpenedId.current = null;
			rowElements.current.get(id)?.focus({ preventScroll: true });
		}
	}, [pageOpen]);

	useEffect(() => {
		if (asking) {
			titleRef.current?.focus();
		}
	}, [asking]);

	const registerRow = useCallback(
		(threadId: string, element: HTMLButtonElement | null) => {
			if (element) {
				rowElements.current.set(threadId, element);
			} else {
				rowElements.current.delete(threadId);
			}
		},
		[]
	);

	const leavePage = () => {
		if (pageOpen) {
			lastOpenedId.current = null;
			port.closeThread();
		}
	};

	const showFeed = (next: QaFilter) => {
		setFilter(next);
		setAsking(false);
		leavePage();
		scrollRef.current?.scrollTo({ top: 0 });
	};

	const openQuestion = (threadId: string) => {
		lastOpenedId.current = threadId;
		port.openThread(threadId);
	};

	const selectTopic = (topic: QaTopic) =>
		showFeed({ ...filter, tab: "top", topicId: topic.id });

	const toggleTopic = (topic: QaTopic) =>
		showFeed({
			...filter,
			topicId: filter.topicId === topic.id ? null : topic.id,
		});

	const selectAgent = (agentId: string) =>
		showFeed({
			...filter,
			agentId: filter.agentId === agentId ? null : agentId,
		});

	const changeQuery = (query: string) => {
		setFilter((previous) => ({ ...previous, query }));
		if (query) {
			setAsking(false);
			leavePage();
		}
	};

	const ask = () => {
		leavePage();
		if (!(asking || draft.title || draft.body)) {
			setDraft(emptyQaDraft(filter));
		}
		setAsking(true);
		scrollRef.current?.scrollTo({ top: 0 });
		titleRef.current?.focus();
	};

	const discard = () => {
		setAsking(false);
		setDraft(emptyQaDraft());
	};

	const submit = () => {
		const input = qaStartInput(draft, snapshot);
		if (!input) {
			return;
		}
		port.startThread(input);
		setAsking(false);
		setDraft(emptyQaDraft());
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			ownsKeys(event.target)
		) {
			return;
		}
		if (event.key === "Escape" && pageOpen) {
			event.preventDefault();
			port.closeThread();
			return;
		}
		if (event.key === "/") {
			event.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
			return;
		}
		const step = STEP_KEYS[event.key];
		if (step === undefined || pageOpen || asking) {
			return;
		}
		const order = feed.map((question) => question.thread.id);
		const focused = [...rowElements.current].find(
			([, element]) => element === document.activeElement
		)?.[0];
		const next = qaStep(order, focused ?? null, step);
		if (next) {
			event.preventDefault();
			const element = rowElements.current.get(next);
			element?.focus();
			element?.scrollIntoView?.({ block: "nearest" });
		}
	};

	const query = filter.query.trim();
	const narrowed = Boolean(filter.topicId || filter.agentId || query);
	const topic = filter.topicId
		? snapshot.groups.find((group) => group.id === filter.topicId)
		: undefined;
	const agent = filter.agentId
		? snapshot.agents.find((candidate) => candidate.id === filter.agentId)
		: undefined;
	let description: string | null = null;
	if (!query && topic && !agent) {
		description = tl("Questions filed under the {topicName} {topicKind}.", {
			topicKind: topic.kind,
			topicName: topic.name,
		});
	} else if (!query && agent && !topic) {
		description = agent.description || null;
	}
	const countLabel = query
		? `${qaCount(feed.length, "result")} for “${query}”`
		: qaCount(feed.length, "question");

	let empty: EmptyCopy | null = null;
	if (feed.length === 0) {
		if (snapshot.threads.length === 0) {
			empty = {
				action: "ask",
				body:
					snapshot.agents.length === 0
						? "Add an agent in Ryu, then ask it a question. Its replies show up here as answers."
						: "Ask an agent a question. Its replies show up here as answers.",
				title: "No questions yet",
			};
		} else if (query) {
			empty = {
				action: "clear",
				body: "Try fewer words, or search for an agent or topic name.",
				title: tl("No results for “{query}”", { query }),
			};
		} else if (filter.tab === "top") {
			empty = {
				action: "ask",
				body: "Questions asked here show up in this list.",
				title: "No questions here yet",
			};
		} else {
			empty = TAB_EMPTY[filter.tab];
		}
	}

	let panel = (
		<QaFeedList
			now={now}
			onOpen={openQuestion}
			onSelectTopic={selectTopic}
			questions={feed}
			registerRow={registerRow}
			viewKey={`${filter.tab}:${filter.topicId}:${filter.agentId}`}
		/>
	);
	if (loading && snapshot.threads.length === 0) {
		panel = <QaFeedSkeleton />;
	} else if (empty) {
		let action: { label: string; onClick: () => void } | null = null;
		if (empty.action === "ask") {
			action = { label: "Ask question", onClick: ask };
		} else if (empty.action === "clear") {
			action = { label: "Clear search", onClick: () => changeQuery("") };
		}
		panel = <QaEmpty action={action} body={empty.body} title={empty.title} />;
	}

	return (
		<div
			aria-busy={loading}
			className="@container/qa relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-qa"
			onKeyDown={onKeyDown}
		>
			<QaTopBar
				onAsk={ask}
				onQueryChange={changeQuery}
				onSubmitSearch={() =>
					rowElements.current.get(feed[0]?.thread.id ?? "")?.focus()
				}
				query={filter.query}
				searchRef={searchRef}
			/>
			{pageOpen ? (
				<QaQuestionPage
					now={now}
					onBack={() => port.closeThread()}
					onOpen={openQuestion}
					onSelectTopic={selectTopic}
					question={activeQuestion}
					ref={pageRef}
					related={related}
					threadView={threadView}
				/>
			) : (
				<div
					className="min-h-0 flex-1 overflow-y-auto"
					data-testid="qa-scroll"
					ref={scrollRef}
				>
					<div className="mx-auto flex w-full max-w-[1120px] gap-10 @[640px]/qa:px-6 px-4">
						<main className="min-w-0 flex-1">
							{asking ? (
								<QaAsk
									agents={snapshot.agents}
									draft={draft}
									groups={snapshot.groups}
									onCancel={discard}
									onChange={setDraft}
									onSubmit={submit}
									titleRef={titleRef}
								/>
							) : (
								<div className="flex flex-col pt-6 pb-16">
									<QaFeedHeading
										description={description}
										onClear={
											narrowed
												? () =>
														showFeed({
															...filter,
															agentId: null,
															query: "",
															topicId: null,
														})
												: null
										}
										title={qaHeading(snapshot, filter)}
									/>
									<div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 pb-4">
										<p
											aria-live="polite"
											className="text-foreground text-sm tabular-nums"
										>
											{countLabel}
										</p>
										<QaTabs
											counts={counts}
											idFor={idFor}
											onSelect={(tab) => showFeed({ ...filter, tab })}
											panelId={panelId}
											tab={filter.tab}
										/>
									</div>
									<div
										aria-labelledby={idFor(filter.tab)}
										id={panelId}
										role="tabpanel"
									>
										{panel}
									</div>
								</div>
							)}
						</main>
						<div className="@[1000px]/qa:block hidden">
							<QaRail
								agentId={filter.agentId}
								answerers={answerers}
								onSelectAgent={selectAgent}
								onSelectTopic={toggleTopic}
								topicId={filter.topicId}
								topics={topics}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
