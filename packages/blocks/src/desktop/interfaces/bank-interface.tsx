import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BankSignedOut } from "./bank-activity.tsx";
import type { BankMonthFilter } from "./bank-feed.tsx";
import { BankHome, type BankTab } from "./bank-home.tsx";
import { BankInsights } from "./bank-insights.tsx";
import {
	agentNames,
	type BankPeriod,
	transactionContext,
} from "./bank-model.ts";
import { BankThreadPanel, BankTransactionPanel } from "./bank-panel.tsx";
import { BankStatements } from "./bank-statements.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** The centered content column the header and every tab share. */
const COLUMN_CLASS =
	"mx-auto w-full max-w-[64rem] px-10 max-sm:px-4 max-md:px-6";

/** How often "today" and the month boundaries refresh. */
const CLOCK_TICK_MS = 60_000;
/** How long a requested focus move may wait for the host to open or close. */
const FOCUS_REQUEST_TTL_MS = 2000;

const TABS: { id: BankTab; label: string }[] = [
	{ id: "home", label: "Home" },
	{ id: "insights", label: "Insights" },
	{ id: "statements", label: "Statements" },
];

interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Wall-clock time that advances on an interval, so "today" rolls over. */
function useNow(interval: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return now;
}

function BankTabs({
	onTab,
	tab,
}: {
	onTab: (tab: BankTab) => void;
	tab: BankTab;
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = TABS.findIndex((candidate) => candidate.id === tab);
		let next: number | null = null;
		if (event.key === "ArrowRight") {
			next = (index + 1) % TABS.length;
		} else if (event.key === "ArrowLeft") {
			next = (index - 1 + TABS.length) % TABS.length;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = TABS.length - 1;
		}
		const target = next === null ? undefined : TABS[next];
		if (!target) {
			return;
		}
		event.preventDefault();
		onTab(target.id);
		event.currentTarget
			.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)
			?.focus();
	};
	return (
		<div
			aria-label="Account sections"
			className="flex h-full items-stretch gap-6 max-sm:gap-4"
			onKeyDown={onKeyDown}
			role="tablist"
		>
			{TABS.map((candidate) => {
				const selected = candidate.id === tab;
				return (
					<button
						aria-controls="bank-tabpanel"
						aria-selected={selected}
						className={cn(
							"relative flex items-center font-medium text-sm outline-none transition-colors duration-100 focus-visible:text-foreground motion-reduce:transition-none",
							"after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:after:bg-ring",
							selected
								? "text-foreground after:bg-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						data-tab={candidate.id}
						id={`bank-tab-${candidate.id}`}
						key={candidate.id}
						onClick={() => onTab(candidate.id)}
						role="tab"
						tabIndex={selected ? 0 : -1}
						type="button"
					>
						{candidate.label}
					</button>
				);
			})}
		</div>
	);
}

function BankSkeleton() {
	return (
		<div aria-hidden="true" className="@container flex flex-col gap-10">
			<div className="grid @[56rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-x-16 gap-y-10">
				<div className="flex flex-col">
					<Skeleton className="h-4 w-16" radius="dense" />
					<Skeleton className="mt-3 h-14 w-56" radius="dense" />
					<Skeleton className="mt-4 h-4 w-72" radius="dense" />
					<div className="mt-8 flex gap-10">
						<Skeleton className="h-11 w-28" radius="dense" />
						<Skeleton className="h-11 w-28" radius="dense" />
					</div>
					<div className="mt-8 flex gap-2">
						<Skeleton className="h-8 w-36" radius="pill" />
						<Skeleton className="h-8 w-24" radius="pill" />
						<Skeleton className="h-8 w-20" radius="pill" />
					</div>
				</div>
				<div className="flex flex-col">
					<Skeleton className="h-4 w-44" radius="dense" />
					<Skeleton className="mt-4 h-52 w-full" radius="row" />
				</div>
			</div>
			<div className="flex flex-col gap-1">
				<Skeleton className="mb-5 h-5 w-28" radius="dense" />
				{["one", "two", "three", "four", "five"].map((key) => (
					<div className="flex items-center gap-3 py-2.5" key={key}>
						<Skeleton className="size-10" radius="pill" />
						<div className="flex flex-1 flex-col gap-1.5">
							<Skeleton className="h-3.5 w-40" radius="dense" />
							<Skeleton className="h-3 w-56" radius="dense" />
						</div>
						<Skeleton className="h-3.5 w-16" radius="dense" />
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Bank: the user's AI spend as a banking app. Home leads with the balance
 * (plan, top-up, and gift credit beneath it), this month's spend and tokens
 * over a 30-day chart, and a day-grouped feed; a transaction opens a sheet
 * with its usage and a way into its conversation. Insights ranks spend by
 * model, agent, and conversation; Statements totals each month. Without an
 * account it says how to connect one and still shows agent activity.
 */
export function BankInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = useNow(CLOCK_TICK_MS);
	const reduceMotion = useReducedMotion();
	const account = snapshot.account;
	const [tab, setTab] = useState<BankTab>("home");
	const [period, setPeriod] = useState<BankPeriod>("this-month");
	const [query, setQuery] = useState("");
	const [month, setMonth] = useState<BankMonthFilter | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const selected = useMemo(
		() =>
			selectedId
				? account?.transactions.find(
						(transaction) => transaction.id === selectedId
					)
				: undefined,
		[account, selectedId]
	);
	const selectedContext = useMemo(
		() => (selected ? transactionContext(snapshot, selected) : null),
		[snapshot, selected]
	);
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const threadAgents = activeThread
		? snapshot.agents.filter((agent) =>
				activeThread.agentIds.includes(agent.id)
			)
		: [];

	const threadOpen = threadView !== null;
	let panelKey: string | null = null;
	if (threadOpen) {
		panelKey = `thread:${activeThreadId ?? "new"}`;
	} else if (selected) {
		panelKey = `transaction:${selected.id}`;
	}

	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const openerRef = useRef<string | null>(null);
	const focusRequestRef = useRef<FocusRequest | null>(null);
	const lastPanelRef = useRef<string | null>(panelKey);

	const requestFocus = (to: FocusRequest["to"]) => {
		focusRequestRef.current = { at: Date.now(), to };
	};
	const selectTransaction = (id: string) => {
		openerRef.current = `[data-transaction-id="${CSS.escape(id)}"]`;
		requestFocus("panel");
		setSelectedId(id);
		if (threadOpen) {
			port.closeThread();
		}
	};
	const closeTransaction = () => {
		requestFocus("opener");
		setSelectedId(null);
	};
	const openThread = (threadId: string) => {
		openerRef.current = `[data-thread-id="${CSS.escape(threadId)}"]`;
		requestFocus("panel");
		port.openThread(threadId);
	};
	const viewConversation = (threadId: string) => {
		requestFocus("panel");
		port.openThread(threadId);
	};
	const backToTransaction = () => {
		requestFocus("panel");
		port.closeThread();
	};
	const closeThread = () => {
		requestFocus("opener");
		setSelectedId(null);
		port.closeThread();
	};
	const closePanel = () => {
		if (threadOpen) {
			closeThread();
		} else if (selected) {
			closeTransaction();
		}
	};
	const changeTab = (next: BankTab) => {
		setTab(next);
		setQuery("");
		setMonth(null);
	};
	const openMonth = (filter: BankMonthFilter) => {
		setTab("home");
		setQuery("");
		setMonth(filter);
	};
	// The document-level Escape listener reads the latest closer through this.
	const closePanelRef = useRef(closePanel);
	closePanelRef.current = closePanel;

	/*
	 * Move focus with the panel: into its heading when it opens from the
	 * interface, and back to the row that opened it when it closes, so focus
	 * never falls to <body>.
	 */
	useLayoutEffect(() => {
		const previous = lastPanelRef.current;
		lastPanelRef.current = panelKey;
		if (previous === panelKey) {
			return;
		}
		const request = focusRequestRef.current;
		const fresh =
			request !== null && Date.now() - request.at < FOCUS_REQUEST_TTL_MS;
		if (panelKey && fresh && request.to === "panel") {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (panelKey) {
			return;
		}
		focusRequestRef.current = null;
		const active = document.activeElement;
		const lost =
			active === null ||
			active === document.body ||
			!rootRef.current?.contains(active);
		if (!((fresh && request.to === "opener") || lost)) {
			return;
		}
		const selector = openerRef.current;
		if (selector) {
			rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
		}
	}, [panelKey]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelKey) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body &&
				!isInterfaceCovered(rootRef.current)
			) {
				event.preventDefault();
				closePanelRef.current();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [panelKey]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelKey &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			closePanel();
		}
	};

	let panel: ReactNode = null;
	if (threadOpen) {
		panel = (
			<BankThreadPanel
				agentsLabel={threadAgents.length > 0 ? agentNames(threadAgents) : null}
				headingRef={headingRef}
				onBack={selected ? backToTransaction : null}
				onClose={closeThread}
				thread={activeThread}
				threadView={threadView}
			/>
		);
	} else if (selected && account) {
		panel = (
			<BankTransactionPanel
				context={selectedContext}
				currency={account.currency}
				headingRef={headingRef}
				key={selected.id}
				onClose={closeTransaction}
				onViewConversation={viewConversation}
				transaction={selected}
			/>
		);
	}

	const activeTab: BankTab = account ? tab : "home";
	let content: ReactNode;
	if (loading) {
		content = <BankSkeleton />;
	} else if (!account) {
		content = (
			<BankSignedOut
				now={now}
				onNewThread={() => port.startThread({})}
				onOpenThread={openThread}
				snapshot={snapshot}
			/>
		);
	} else if (activeTab === "insights") {
		content = (
			<BankInsights
				account={account}
				now={now}
				onOpenThread={openThread}
				onPeriod={setPeriod}
				period={period}
				snapshot={snapshot}
			/>
		);
	} else if (activeTab === "statements") {
		content = <BankStatements account={account} onOpenMonth={openMonth} />;
	} else {
		content = (
			<BankHome
				account={account}
				month={month}
				now={now}
				onClearMonth={() => setMonth(null)}
				onQuery={setQuery}
				onSelect={selectTransaction}
				onTab={changeTab}
				query={query}
				selectedId={panelKey ? selectedId : null}
				snapshot={snapshot}
			/>
		);
	}

	const showTabs = !loading && account !== undefined;
	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-bank"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<div className="relative flex min-h-0 flex-1">
				<main className="min-w-0 flex-1 overflow-y-auto">
					<header className="sticky top-0 z-10 h-14 border-border border-b bg-background">
						<div
							className={cn(
								COLUMN_CLASS,
								"flex h-full items-stretch gap-8 max-sm:gap-5"
							)}
						>
							<h1 className="flex items-center font-semibold text-base text-foreground">
								Account
							</h1>
							{showTabs ? <BankTabs onTab={changeTab} tab={activeTab} /> : null}
						</div>
					</header>
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						aria-labelledby={showTabs ? `bank-tab-${activeTab}` : undefined}
						className={cn(COLUMN_CLASS, "pt-10 pb-16 max-sm:pt-6")}
						id="bank-tabpanel"
						initial={reduceMotion ? false : { opacity: 0, y: 4 }}
						key={loading ? "loading" : activeTab}
						role={showTabs ? "tabpanel" : undefined}
						transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
					>
						{content}
					</motion.div>
				</main>
				<AnimatePresence>
					{panel ? (
						<motion.button
							animate={{ opacity: 1 }}
							aria-hidden="true"
							className="absolute inset-0 z-20 cursor-default bg-background/60 xl:hidden"
							exit={{ opacity: 0 }}
							initial={reduceMotion ? false : { opacity: 0 }}
							key="scrim"
							onClick={closePanel}
							tabIndex={-1}
							transition={{ duration: 0.15 }}
							type="button"
						/>
					) : null}
				</AnimatePresence>
				{panel}
			</div>
		</div>
	);
}
