import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CinemaBillboard } from "./cinema-billboard.tsx";
import { CinemaDetails } from "./cinema-details.tsx";
import { CinemaGrid } from "./cinema-grid.tsx";
import {
	cinemaOwnsKeys,
	useCinemaClock,
	useCinemaSize,
} from "./cinema-hooks.ts";
import {
	BILLBOARD_COMPACT_MAX_WIDTH,
	billboardHeightFor,
	COLLECTION_EMPTY,
	NAV_COMPACT_MAX_WIDTH,
	PANEL_SPLIT_MIN_WIDTH,
	PREVIEW_DELAY,
	PREVIEW_GRACE,
	type PreviewState,
	panelWidthFor,
	RELATED_LIMIT,
} from "./cinema-interface-layout.ts";
import { CinemaInterfaceSearchEmpty } from "./cinema-interface-search-empty.tsx";
import {
	type CinemaCollectionId,
	type CinemaTitle,
	cinemaCardWidth,
	cinemaCollection,
	cinemaCollectionTitle,
	cinemaFeatured,
	cinemaGutter,
	cinemaPerRow,
	cinemaRelated,
	cinemaRows,
	cinemaSearch,
	cinemaTitles,
	isCinemaCollection,
} from "./cinema-model.ts";
import { CinemaNav, type CinemaPage } from "./cinema-nav.tsx";
import { CINEMA_SURFACE } from "./cinema-palette.ts";
import { CinemaPanel } from "./cinema-panel.tsx";
import { CINEMA_POSTER_ATTRIBUTE } from "./cinema-poster.tsx";
import { CinemaPreview } from "./cinema-preview.tsx";
import { CinemaRow } from "./cinema-row.tsx";
import { CinemaEmpty, CinemaSkeleton } from "./cinema-states.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Cinema: threads as a streaming catalogue, after Netflix on the web. A
 * billboard features the live (or most recent) conversation over generated
 * key art; rows below shelve what waits on you, what is live, what failed,
 * what moved last, the most active, pinned, and one row per agent. Resting on
 * a poster grows a preview with Open; clicking it opens More info. Open shows
 * the host's real conversation in a full-height panel.
 */
export function CinemaInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["cinema"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const panelHeadingRef = useRef<HTMLHeadingElement>(null);
	const openerRef = useRef<HTMLElement | null>(null);
	const lastOpenedId = useRef<string | null>(activeThreadId);
	const hoverTimer = useRef<number | null>(null);
	const closeTimer = useRef<number | null>(null);

	const tl = useLiteralMessages();
	const size = useCinemaSize(rootRef);
	const now = useCinemaClock();
	const reduceMotion = useReducedMotion();
	const [page, setPage] = useState<CinemaPage>("home");
	const [query, setQuery] = useState("");
	const [detailsId, setDetailsId] = useState<string | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [scrolled, setScrolled] = useState(false);

	const titles = useMemo(() => cinemaTitles(snapshot), [snapshot]);
	const rows = useMemo(() => cinemaRows(snapshot, titles), [snapshot, titles]);
	const featured = useMemo(() => cinemaFeatured(titles), [titles]);
	const titleById = useCallback(
		(threadId: string | null): CinemaTitle | null =>
			threadId
				? (titles.find((title) => title.thread.id === threadId) ?? null)
				: null,
		[titles]
	);

	const open = threadView !== null && threadView !== undefined;
	const overlay = open && size.width < PANEL_SPLIT_MIN_WIDTH;
	const panelWidth = panelWidthFor(size.width);
	const catalogWidth = open && !overlay ? size.width - panelWidth : size.width;
	const gutter = cinemaGutter(catalogWidth);
	const contentWidth = Math.max(0, catalogWidth - gutter * 2);
	const perRow = cinemaPerRow(contentWidth);
	const cardWidth = cinemaCardWidth(contentWidth, perRow);
	const billboardHeight = billboardHeightFor(catalogWidth, size.height);
	const compactBillboard = catalogWidth < BILLBOARD_COMPACT_MAX_WIDTH;
	const overlap = compactBillboard
		? 32
		: Math.round((billboardHeight * 0.12) / 4) * 4;

	// A collection page whose agent left the snapshot falls back to Home.
	const currentPage: CinemaPage =
		page !== "home" && !isCinemaCollection(snapshot, page) ? "home" : page;

	const clearTimers = useCallback(() => {
		for (const timer of [hoverTimer, closeTimer]) {
			if (timer.current !== null) {
				window.clearTimeout(timer.current);
				timer.current = null;
			}
		}
	}, []);
	useEffect(() => clearTimers, [clearTimers]);

	const closePreview = useCallback(() => {
		clearTimers();
		setPreview(null);
	}, [clearTimers]);

	const hoverStart = useCallback(
		(element: HTMLElement, title: CinemaTitle) => {
			clearTimers();
			hoverTimer.current = window.setTimeout(() => {
				hoverTimer.current = null;
				const frame = frameRef.current;
				if (!(frame && element.isConnected)) {
					return;
				}
				const outer = frame.getBoundingClientRect();
				const inner = element.getBoundingClientRect();
				setPreview({
					rect: {
						height: inner.height,
						left: inner.left - outer.left,
						top: inner.top - outer.top,
						width: inner.width,
					},
					threadId: title.thread.id,
				});
			}, PREVIEW_DELAY);
		},
		[clearTimers]
	);

	const hoverEnd = useCallback(() => {
		if (hoverTimer.current !== null) {
			window.clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
		}
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null;
			setPreview(null);
		}, PREVIEW_GRACE);
	}, []);

	const keepPreview = useCallback(() => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const closeDetails = useCallback(() => {
		setDetailsId(null);
		const opener = openerRef.current;
		openerRef.current = null;
		if (opener?.isConnected) {
			opener.focus({ preventScroll: true });
		}
	}, []);

	const openThread = useCallback(
		(threadId: string) => {
			closePreview();
			closeDetails();
			lastOpenedId.current = threadId;
			port.openThread(threadId);
		},
		[closeDetails, closePreview, port]
	);

	const showDetails = useCallback(
		(threadId: string, opener: HTMLElement) => {
			closePreview();
			openerRef.current = opener;
			setDetailsId(threadId);
		},
		[closePreview]
	);

	const startThread = useCallback(
		(agentId: string | null) => {
			closePreview();
			closeDetails();
			port.startThread(agentId ? { agentId } : {});
		},
		[closeDetails, closePreview, port]
	);

	const navigate = useCallback(
		(next: CinemaPage) => {
			closePreview();
			setQuery("");
			setPage(next);
			scrollRef.current?.scrollTo({ top: 0 });
		},
		[closePreview]
	);

	const explore = useCallback(
		(id: CinemaCollectionId) => navigate(id),
		[navigate]
	);

	const changeQuery = useCallback(
		(next: string) => {
			closePreview();
			setQuery(next);
			scrollRef.current?.scrollTo({ top: 0 });
		},
		[closePreview]
	);

	useEffect(() => {
		if (activeThreadId) {
			lastOpenedId.current = activeThreadId;
		}
	}, [activeThreadId]);

	// Opening moves focus to the panel if it was in the catalogue (or nowhere);
	// closing returns it to the poster the thread came from.
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) {
			const focused = document.activeElement;
			if (
				!focused ||
				focused === document.body ||
				scrollRef.current?.contains(focused)
			) {
				panelHeadingRef.current?.focus({ preventScroll: true });
			}
		}
		if (!open && wasOpen.current && lastOpenedId.current) {
			const poster = scrollRef.current?.querySelector<HTMLElement>(
				`[${CINEMA_POSTER_ATTRIBUTE}="${CSS.escape(lastOpenedId.current)}"]`
			);
			poster?.focus({ preventScroll: true });
		}
		wasOpen.current = open;
	}, [open]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.metaKey || event.ctrlKey) {
				return;
			}
			if (detailsId) {
				return;
			}
			if (event.key === "/" && !cinemaOwnsKeys(event.target)) {
				event.preventDefault();
				searchRef.current?.focus();
				return;
			}
			if (event.key !== "Escape" || cinemaOwnsKeys(event.target)) {
				return;
			}
			if (preview) {
				event.preventDefault();
				closePreview();
			} else if (open) {
				event.preventDefault();
				port.closeThread();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [closePreview, detailsId, open, port, preview]);

	const detailsTitle = titleById(detailsId);
	const previewTitle = titleById(preview?.threadId ?? null);
	const activeTitle = titleById(activeThreadId);
	const related = useMemo(
		() => (detailsId ? cinemaRelated(titles, detailsId, RELATED_LIMIT) : []),
		[titles, detailsId]
	);

	const posterHandlers = {
		activeThreadId,
		onHoverEnd: hoverEnd,
		onHoverStart: hoverStart,
		onSelect: showDetails,
	};

	let body: ReactNode;
	if (loading) {
		body = (
			<CinemaSkeleton
				billboardHeight={billboardHeight}
				cardWidth={cardWidth}
				gutter={gutter}
				perRow={perRow}
			/>
		);
	} else if (titles.length === 0) {
		body = <CinemaEmpty agents={snapshot.agents} onNew={startThread} />;
	} else if (query.trim()) {
		const results = cinemaSearch(titles, query);
		body = (
			<CinemaGrid
				{...posterHandlers}
				agent={null}
				empty={<CinemaInterfaceSearchEmpty query={query.trim()} />}
				gutter={gutter}
				heading={tl("Results for “{query}”", { query: query.trim() })}
				onNew={startThread}
				perRow={perRow}
				subheading={
					results.length > 0
						? `${results.length.toString()} ${results.length === 1 ? "title" : "titles"}`
						: undefined
				}
				titles={results}
			/>
		);
	} else if (currentPage === "home") {
		body = (
			<>
				{featured ? (
					<CinemaBillboard
						bottomInset={overlap}
						gutter={gutter}
						height={billboardHeight}
						now={now}
						onMore={showDetails}
						onOpen={openThread}
						reduceMotion={reduceMotion}
						title={featured}
						width={catalogWidth}
					/>
				) : null}
				<div
					className="relative z-10 flex flex-col gap-10 pb-20"
					style={{ marginTop: -overlap }}
				>
					{rows.map((row) => (
						<CinemaRow
							{...posterHandlers}
							cardWidth={cardWidth}
							gutter={gutter}
							key={row.id}
							onExplore={explore}
							perRow={perRow}
							reduceMotion={reduceMotion}
							row={row}
							total={cinemaCollection(snapshot, row.id, titles).length}
						/>
					))}
				</div>
			</>
		);
	} else {
		const items = cinemaCollection(snapshot, currentPage, titles);
		const agentId = currentPage.startsWith("agent:")
			? currentPage.slice("agent:".length)
			: null;
		const agent = snapshot.agents.find((item) => item.id === agentId) ?? null;
		body = (
			<CinemaGrid
				{...posterHandlers}
				agent={agent}
				empty={
					<p className="text-muted-foreground text-sm leading-6">
						{COLLECTION_EMPTY[currentPage] ?? "No threads yet."}
					</p>
				}
				gutter={gutter}
				heading={cinemaCollectionTitle(snapshot, currentPage)}
				onNew={startThread}
				perRow={perRow}
				subheading={agent?.description || undefined}
				titles={items}
			/>
		);
	}

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="dark relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-cinema"
			ref={rootRef}
			style={CINEMA_SURFACE}
		>
			<div
				className="relative h-full min-w-0 flex-1"
				inert={overlay}
				ref={frameRef}
			>
				<div
					className="h-full overflow-y-auto overflow-x-hidden overscroll-contain"
					onScroll={(event) => {
						setScrolled(event.currentTarget.scrollTop > 8);
						if (preview) {
							closePreview();
						}
					}}
					ref={scrollRef}
				>
					<CinemaNav
						agents={snapshot.agents}
						compact={catalogWidth < NAV_COMPACT_MAX_WIDTH}
						gutter={gutter}
						onNavigate={navigate}
						onNew={startThread}
						onQuery={changeQuery}
						page={currentPage}
						query={query}
						scrolled={scrolled || currentPage !== "home" || query.length > 0}
						searchRef={searchRef}
					/>
					<main aria-label="Catalogue">{body}</main>
				</div>
				<AnimatePresence>
					{preview && previewTitle ? (
						<CinemaPreview
							frameHeight={size.height}
							frameWidth={catalogWidth}
							gutter={gutter}
							key={preview.threadId}
							now={now}
							onClose={closePreview}
							onKeep={keepPreview}
							onMore={showDetails}
							onNew={(agentId) => startThread(agentId)}
							onOpen={openThread}
							rect={preview.rect}
							reduceMotion={reduceMotion}
							title={previewTitle}
						/>
					) : null}
				</AnimatePresence>
			</div>
			{open ? (
				<CinemaPanel
					headingRef={panelHeadingRef}
					onClose={() => port.closeThread()}
					onMore={showDetails}
					overlay={overlay}
					reduceMotion={reduceMotion}
					threadView={threadView}
					title={activeTitle}
					width={panelWidth}
				/>
			) : null}
			<AnimatePresence>
				{detailsTitle ? (
					<CinemaDetails
						compact={size.width < BILLBOARD_COMPACT_MAX_WIDTH}
						key="cinema-details"
						now={now}
						onClose={closeDetails}
						onNew={(agentId) => startThread(agentId)}
						onOpen={openThread}
						onSelect={(threadId) => setDetailsId(threadId)}
						reduceMotion={reduceMotion}
						related={related}
						title={detailsTitle}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
