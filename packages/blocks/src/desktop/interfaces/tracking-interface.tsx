import { cn } from "@ryu/ui/lib/utils";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { TrackingList } from "./tracking-list.tsx";
import {
	buildParcels,
	defaultTab,
	matchesQuery,
	parcelsForTab,
	type TrackingTab,
	tabCounts,
	trackingTab,
} from "./tracking-model.ts";
import { TrackingPage, TrackingPageSkeleton } from "./tracking-page.tsx";
import { TrackingThreadPanel } from "./tracking-panel.tsx";
import { TrackingSend } from "./tracking-send.tsx";

const MINUTE = 60_000;
/** Below this width the list and the tracking page take turns. */
const STACKED_MAX_WIDTH = 760;
/** At or above this width the conversation docks beside the tracking page. */
const DOCKED_MIN_WIDTH = 1100;
/**
 * Between this width and DOCKED_MIN_WIDTH an open conversation docks beside
 * the tracking page and the list steps aside, so the stepper stays in view.
 */
const COLLAPSE_LIST_MIN_WIDTH = 860;
/** At or above this width the list gets its roomier column. */
const WIDE_LIST_MIN_WIDTH = 1180;
/** Width assumed before the first measurement (and where layout is absent). */
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				setWidth(entry.contentRect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isTextField(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

/**
 * Tracking: conversations as parcels. "My deliveries" lists them by stage;
 * the main page tracks the selected one with a route, a five-step stepper,
 * and its history. "View conversation" opens the host's real chat surface in
 * a panel, and "Send a parcel" starts a thread through the port.
 */
export function TrackingInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const now = useMinuteClock();
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusPanelRef = useRef(false);
	const measured = useElementWidth(rootRef);
	const width = measured || UNMEASURED_WIDTH;
	const stacked = width < STACKED_MAX_WIDTH;
	const panelOpen = threadView !== null;
	// Narrower than DOCKED_MIN_WIDTH, the list makes room for a docked panel.
	const listCollapsed =
		panelOpen && width >= COLLAPSE_LIST_MIN_WIDTH && width < DOCKED_MIN_WIDTH;
	const docked = width >= DOCKED_MIN_WIDTH || listCollapsed;

	const parcels = useMemo(() => buildParcels(snapshot, now), [snapshot, now]);
	const events = snapshot.events ?? [];

	const [tab, setTab] = useState<TrackingTab>(() =>
		defaultTab(parcels, activeThreadId)
	);
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(activeThreadId);
	const [sending, setSending] = useState(false);
	const [showPage, setShowPage] = useState(activeThreadId !== null);

	// Search narrows every tab at once, so the counts say where matches are.
	const matched = useMemo(
		() => parcels.filter((parcel) => matchesQuery(parcel, query)),
		[parcels, query]
	);
	const counts = useMemo(() => tabCounts(matched), [matched]);
	const visible = useMemo(() => parcelsForTab(matched, tab), [matched, tab]);
	// A picked parcel stays on screen while you search; otherwise follow the list.
	const selected =
		parcels.find((parcel) => parcel.thread.id === selectedId) ?? visible[0];
	const openParcel = parcels.find(
		(parcel) => parcel.thread.id === activeThreadId
	);

	// Follow the host: when a thread opens elsewhere (or a new one starts),
	// select it and switch to the tab it lives in. Only a change of the open
	// thread is followed, so clock ticks and snapshot pushes never undo a pick.
	const followedIdRef = useRef<string | null>(null);
	const followedTabIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!activeThreadId) {
			followedIdRef.current = null;
			followedTabIdRef.current = null;
			return;
		}
		if (followedIdRef.current !== activeThreadId) {
			followedIdRef.current = activeThreadId;
			followedTabIdRef.current = null;
			setSelectedId(activeThreadId);
		}
		if (followedTabIdRef.current === activeThreadId) {
			return;
		}
		// A just-started thread may land in a later snapshot; switch tabs then.
		const parcel = parcels.find((item) => item.thread.id === activeThreadId);
		if (parcel) {
			followedTabIdRef.current = activeThreadId;
			setTab((current) =>
				current === "all" || current === trackingTab(parcel.stage)
					? current
					: (trackingTab(parcel.stage) ?? "all")
			);
		}
	}, [activeThreadId, parcels]);

	useEffect(() => {
		if (panelOpen && focusPanelRef.current) {
			focusPanelRef.current = false;
			headingRef.current?.focus();
		}
	}, [panelOpen]);

	const { closeThread, openThread, startThread } = port;
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				!isTextField(event.target)
			) {
				event.preventDefault();
				closeThread();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [closeThread, panelOpen]);

	const select = useCallback((threadId: string) => {
		setSelectedId(threadId);
		setSending(false);
		setShowPage(true);
	}, []);
	const open = useCallback(
		(threadId: string) => {
			focusPanelRef.current = true;
			openThread(threadId);
		},
		[openThread]
	);
	const changeTab = useCallback((next: TrackingTab) => {
		setTab(next);
		setSelectedId(null);
	}, []);
	const changeQuery = useCallback(
		(next: string) => {
			setQuery(next);
			// Pin what is on screen so typing does not swap the page under you.
			setSelectedId((current) => current ?? selected?.thread.id ?? null);
		},
		[selected]
	);
	const startSending = useCallback(() => {
		setSending(true);
		setShowPage(true);
	}, []);
	const submit = useCallback(
		(input: { agentId?: string; prompt: string }) => {
			focusPanelRef.current = true;
			startThread(input);
			setSending(false);
		},
		[startThread]
	);

	const noThreads = !loading && parcels.length === 0;
	const sendView = sending || noThreads;

	let main = <TrackingPageSkeleton />;
	if (!loading && sendView) {
		main = (
			<TrackingSend
				agents={snapshot.agents}
				onCancel={noThreads ? null : () => setSending(false)}
				onSubmit={submit}
			/>
		);
	} else if (!loading && selected) {
		main = (
			<TrackingPage
				events={events}
				isOpen={panelOpen && activeThreadId === selected.thread.id}
				now={now}
				onBack={stacked ? () => setShowPage(false) : undefined}
				onOpen={open}
				parcel={selected}
			/>
		);
	} else if (!loading) {
		main = (
			<div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
				<p className="font-medium text-foreground text-sm">
					{query.trim() ? "No deliveries match" : "Nothing in this tab"}
				</p>
				<p className="text-muted-foreground text-sm">
					{query.trim()
						? "Try a tracking number, an item, or a courier's name."
						: "Pick another tab to see its deliveries."}
				</p>
			</div>
		);
	}

	const panel = (
		<TrackingThreadPanel
			docked={docked}
			headingRef={headingRef}
			onClose={closeThread}
			parcel={openParcel}
			threadView={threadView}
		/>
	);
	const listShown = !(listCollapsed || (stacked && (showPage || sendView)));
	const wideList = width >= WIDE_LIST_MIN_WIDTH;
	const listWidth = wideList ? "w-[360px]" : "w-[340px]";

	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-tracking"
			ref={rootRef}
		>
			{listShown ? (
				<div
					className={cn(
						"flex min-h-0 shrink-0 flex-col",
						stacked ? "w-full" : cn(listWidth, "border-border border-r")
					)}
				>
					<TrackingList
						canSend={snapshot.agents.length > 0}
						compact={!(stacked || wideList)}
						counts={counts}
						events={events}
						loading={loading}
						now={now}
						onQueryChange={changeQuery}
						onSelect={select}
						onSend={startSending}
						onTabChange={changeTab}
						parcels={visible}
						query={query}
						selectedId={sendView ? null : (selected?.thread.id ?? null)}
						tab={tab}
					/>
				</div>
			) : null}
			{stacked && listShown ? null : (
				<div className="relative flex min-h-0 min-w-0 flex-1">
					<main
						aria-busy={loading || undefined}
						aria-label="Tracking"
						className="min-h-0 min-w-0 flex-1 overflow-y-auto"
					>
						{main}
					</main>
					{panelOpen && !docked && !stacked ? panel : null}
				</div>
			)}
			{panelOpen && (docked || stacked) ? panel : null}
		</div>
	);
}
