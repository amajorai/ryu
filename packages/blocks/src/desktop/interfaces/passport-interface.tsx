import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgentAct,
	type InterfaceParamsByRenderer,
	type InterfaceThread,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import {
	BookOpen,
	ChevronLeft,
	ChevronRight,
	Map as MapIcon,
	Stamp,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameIconButton,
	GameTitlePlate,
} from "./game-hud.tsx";
import {
	GameHudSlot,
	GameSheet,
	GameShell,
	gameSheetCover,
} from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	NARROW_STAGE,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	IsoStage,
	IsoZoomControls,
	useGameNight,
	useIsoView,
	useReducedMotion,
	useWebGLProbe,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import {
	ActAnnouncer,
	ActStatus,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	actOfficers,
	deniedOf,
	deskKeeps,
	deskPaths,
	EmptyCustomsDesk,
	NO_VISAS_WAITING,
	PassportActProps,
	ROOMY_DESK,
} from "./passport-acts.tsx";
import { BOARD, Booklet, type BookTab, TAB_ROOM } from "./passport-booklet.tsx";
import {
	countryLabel,
	type DeskActors,
	type DeskLayout,
	type DeskMode,
	DeskScene,
	deskFraming,
	layoutDesk,
	stationLabel,
} from "./passport-desk.tsx";
import { TravelMap } from "./passport-map.tsx";
import {
	bookletSpreads,
	buildPassport,
	countryPage,
	findStamp,
	openingPage,
	type Passport,
	type PassportCountry,
	type PassportSpread,
	plural,
	singleSpreads,
	spreadOfPage,
	stampPage,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
	upcomingTravel,
} from "./passport-model.ts";
import { usePassportNavigation } from "./passport-navigation.ts";
import {
	BlankFace,
	CoverFace,
	IdentityFace,
	NotesFace,
	VisaFace,
} from "./passport-page-face.tsx";
import {
	BlankPage,
	CoverPage,
	IdentityPage,
	NotesPage,
	PAGE_WIDTH,
	VisaPage,
} from "./passport-pages.tsx";
import {
	chromeInk,
	deskArt,
	passportVars,
	stampInk,
} from "./passport-palette.ts";
import { ImmigrationRecord, VisaApplication } from "./passport-record.tsx";
import { PassportArtProvider } from "./passport-stamp.tsx";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

type PassportSheet = "booklet" | "map";

const FIRST_SEEN_KEY = "ryu.interfaces.passport.first-seen";
const FIRST_SEEN_LIMIT = 500;
/** The booklet's page in the sheet never prints smaller than this. */
const MIN_SCALE = 0.6;
const MAX_SCALE = 1.2;

function readFirstSeen(): Record<string, string> {
	try {
		const raw = window.localStorage.getItem(FIRST_SEEN_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object") {
			return {};
		}
		const result: Record<string, string> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				result[id] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

/**
 * Persist first-seen times. Threads still in the snapshot are always kept, so
 * their entry dates never reset; only threads that have left it are trimmed
 * (newest first-seen kept) to stay under the limit.
 */
function writeFirstSeen(
	map: Record<string, string>,
	currentIds: ReadonlySet<string>
): void {
	try {
		const entries = Object.entries(map);
		const current = entries.filter(([id]) => currentIds.has(id));
		const departed = entries
			.filter(([id]) => !currentIds.has(id))
			.sort((a, b) => b[1].localeCompare(a[1]))
			.slice(0, Math.max(0, FIRST_SEEN_LIMIT - current.length));
		window.localStorage.setItem(
			FIRST_SEEN_KEY,
			JSON.stringify(Object.fromEntries([...current, ...departed]))
		);
	} catch {
		// Storage can be blocked; entry dates then fall back to latest activity.
	}
}

/**
 * The earliest time this viewer has seen each thread, kept per browser, so a
 * stamp's entry date can stay put while its latest date moves on.
 */
function useFirstSeen(threads: InterfaceThread[]): Record<string, string> {
	const [firstSeen, setFirstSeen] = useState<Record<string, string>>({});
	useEffect(() => {
		const stored = readFirstSeen();
		let changed = false;
		for (const thread of threads) {
			const known = stored[thread.id];
			if (!known || thread.updatedAt < known) {
				stored[thread.id] = thread.updatedAt;
				changed = true;
			}
		}
		if (changed) {
			writeFirstSeen(stored, new Set(threads.map((thread) => thread.id)));
		}
		setFirstSeen(stored);
	}, [threads]);
	return firstSeen;
}

/** The element's size, kept current with a ResizeObserver. */
function useElementSize(ref: { current: HTMLElement | null }) {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		setSize({ height: rect.height, width: rect.width });
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((records) => {
			const box = records[0]?.contentRect;
			if (box) {
				setSize({ height: box.height, width: box.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

function isEditable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

/** "Cover", "Page 3 of 12" or "Pages 3–4 of 12". */
export function spreadCaption(
	spread: PassportSpread | undefined,
	pageCount: number
): string {
	if (!spread || spread.right === 0) {
		return "Cover";
	}
	const last = pageCount - 1;
	const pages = [spread.left, spread.right].filter(
		(page): page is number => page !== null
	);
	return pages.length > 1
		? `Pages ${pages[0]}–${pages[1]} of ${last}`
		: `Page ${pages[0]} of ${last}`;
}

/**
 * A visa page's status line from its agent's act: where the agent stands,
 * in the passport's words. Without the act layer, only a running agent
 * says anything ("In session now").
 */
export function visaStatus(
	country: PassportCountry | null,
	act: InterfaceAgentAct | undefined
): string | null {
	if (!country) {
		return null;
	}
	if (!act) {
		return country.agent.status === "working" ? "In session now" : null;
	}
	switch (act.act) {
		case "asking":
			return "Waiting for your signature";
		case "blocked":
			return deniedOf(act) ? "Entry denied" : "Stopped";
		case "limited":
			return "Border closed";
		case "working":
			return act.stalled ? "May have stopped" : "Processing";
		case "delivering":
			return "Answer ready";
		case "waiting":
			return "Waiting to start";
		default:
			return "Cleared";
	}
}

function LoadingIsles() {
	return (
		<div className="flex w-full flex-wrap content-center items-start justify-center gap-6 p-8">
			{["a", "b", "c", "d", "e", "f"].map((key) => (
				<div className="flex w-56 flex-col gap-3" key={key}>
					<Skeleton className="h-28 w-full rounded-lg" />
					<Skeleton className="h-4 w-24" />
				</div>
			))}
			<span className="sr-only">Loading the passport</span>
		</div>
	);
}

/** One page tab in the HUD: the identity page, or a country's visa pages. */
export interface PageTab {
	active: boolean;
	code: string;
	/** The country's stamp ink index (null: the passport's own pages). */
	ink: number | null;
	label: string;
	page: number;
}

/** The page tabs, in page order: identity, every country, unassigned. */
export function pageTabs(
	passport: Passport,
	spread: PassportSpread | undefined
): PageTab[] {
	const onSpread = (page: number) =>
		page >= 0 && (spread?.left === page || spread?.right === page);
	const identity = passport.pages.findIndex((page) => page.kind === "identity");
	const tabs: PageTab[] = [
		{
			active: onSpread(identity),
			code: "ID",
			ink: null,
			label: "Identity page",
			page: identity,
		},
	];
	for (const country of passport.countries) {
		const pages = passport.pages.flatMap((page, index) =>
			page.kind === "visa" && page.countryId === country.id ? [index] : []
		);
		tabs.push({
			active: pages.some(onSpread),
			code: country.code,
			ink: country.style.ink,
			label: `${country.agent.name} visa pages`,
			page: countryPage(passport.pages, country.id),
		});
	}
	const unassigned = countryPage(passport.pages, null);
	if (unassigned > 0) {
		tabs.push({
			active: onSpread(unassigned),
			code: UNASSIGNED_CODE,
			ink: null,
			label: `${UNASSIGNED_LABEL} visa pages`,
			page: unassigned,
		});
	}
	return tabs;
}

/**
 * The booklet's page controls in the HUD: previous and next page, where
 * the booklet is open, and a tab per page to turn straight to it (on a
 * phone the tabs scroll sideways under the arrows).
 */
export function PageNav({
	caption,
	compact,
	hasNext,
	hasPrevious,
	onNext,
	onPage,
	onPrevious,
	tabs,
}: {
	caption: string;
	compact: boolean;
	hasNext: boolean;
	hasPrevious: boolean;
	onNext: () => void;
	onPage: (page: number) => void;
	onPrevious: () => void;
	tabs: readonly PageTab[];
}) {
	return (
		<nav
			aria-label="Passport pages"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex min-w-0 gap-2 p-1.5",
				compact ? "flex-col items-stretch" : "items-center"
			)}
			data-passport-pages=""
		>
			<div className="flex shrink-0 items-center justify-between gap-1">
				<GameIconButton
					disabled={!hasPrevious}
					label="Previous page"
					onClick={onPrevious}
					title="Previous page (Page Up)"
				>
					<ChevronLeft
						aria-hidden="true"
						className="size-5"
						strokeWidth={2.75}
					/>
				</GameIconButton>
				<p
					aria-live="polite"
					className="gk-display min-w-32 text-center text-[15px] tabular-nums"
					data-page-caption=""
				>
					{caption}
				</p>
				<GameIconButton
					disabled={!hasNext}
					label="Next page"
					onClick={onNext}
					title="Next page (Page Down)"
				>
					<ChevronRight
						aria-hidden="true"
						className="size-5"
						strokeWidth={2.75}
					/>
				</GameIconButton>
			</div>
			<ul
				aria-label="Page tabs"
				className="flex min-w-0 gap-1 overflow-x-auto p-0.5"
			>
				{tabs.map((tab) => (
					<li className="shrink-0" key={tab.code}>
						<button
							aria-current={tab.active ? "page" : undefined}
							aria-label={tab.label}
							className={cn(
								"gk-display grid h-9 min-w-11 place-items-center rounded-lg border-2 px-1.5 font-mono text-[12px] tracking-[0.04em] transition-colors hover:bg-(--gk-plate-sunk)",
								tab.active
									? "border-(--gk-edge) bg-(--gk-plate-sunk)"
									: "border-transparent",
								GAME_FOCUS
							)}
							data-page-tab={tab.code}
							onClick={() => onPage(tab.page)}
							style={
								tab.ink === null ? undefined : { color: chromeInk(tab.ink) }
							}
							title={tab.label}
							type="button"
						>
							{tab.code}
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}

/**
 * Passport: the workspace as a passport booklet lying open on a desk, a
 * diorama on the 3D game kit (passport-desk.tsx). Turning its pages is how
 * you move through it: the identity page sums it up, and every agent has a
 * visa page with its photo (its villager), name, emblem and status, and its
 * conversations as entry stamps. Each visa page's index tab pokes out round
 * the booklet, with the agent's villager on it: its plate files a visa
 * application, which starts a new conversation (or, with the act layer,
 * answers the agent's ask). Opening a stamp files the host's conversation
 * as an immigration record. The Booklet sheet reads the open page up close
 * and the Map of travels lists the same entries plainly.
 */
/** The booklet sheet's width on wide stages (px): the page reads larger. */
const BOOKLET_SHEET = 580;

/** The Passport's own settings, resolved from its live params. */
export function passportSettings(
	params: InterfaceParamsByRenderer["passport"] | undefined
): Required<InterfaceParamsByRenderer["passport"]> {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("passport", params) as Required<
		InterfaceParamsByRenderer["passport"]
	>;
}

export function PassportInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["passport"]>) {
	const { cover: coverColor } = passportSettings(params);
	const bookletVars = passportVars(coverColor);
	const kitSettings = useGameKitSettings();
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const root = useElementSize(rootRef);
	const stage = useElementSize(stageRef);
	const reduceMotion = useReducedMotion();
	const night = useGameNight(rootRef);
	const isoView = useIsoView();
	const probe = useWebGLProbe();
	const firstSeen = useFirstSeen(snapshot.threads);

	const passport = useMemo(
		() => buildPassport(snapshot, firstSeen),
		[snapshot, firstSeen]
	);
	const [now] = useState(() => Date.now());
	const upcoming = useMemo(
		() => upcomingTravel(snapshot.events, now, 3),
		[snapshot.events, now]
	);
	const agentIds = useMemo(
		() => snapshot.agents.map((agent) => agent.id),
		[snapshot.agents]
	);
	const { looks } = useVillagerLooks(agentIds, night);
	const art = useMemo(() => deskArt(night, coverColor), [coverColor, night]);
	const actsView = useActs(snapshot);
	const { acts, enabled: actsOn, nowMs, unowned } = actsView;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const headingRef = useRef<HTMLHeadingElement>(null);

	const [sheet, setSheet] = useState<PassportSheet | null>(null);
	const [applyingTo, setApplyingTo] = useState<string | null>(null);

	const recordOpen = threadView !== null && threadView !== undefined;
	const applying = applyingTo
		? (passport.countries.find((country) => country.id === applyingTo) ?? null)
		: null;
	const panelOpen = recordOpen || applying !== null;
	const anySheet = panelOpen || sheet !== null;
	// The sheet floats over the desk's right side; the desk moves over to
	// the rest (on a narrow stage the sheet covers everything).
	// The booklet's sheet is wider, so its page reads at a good size.
	const sheetWidth =
		sheet === "booklet" && !panelOpen ? BOOKLET_SHEET : undefined;
	const cover = anySheet ? gameSheetCover(root.width, sheetWidth) : 0;
	const sheetCover = cover < root.width ? cover : 0;
	const roomWidth = Math.max(0, root.width - sheetCover);
	const compact = root.width > 0 && roomWidth < 720;
	// A phone (or a stage squeezed beside a sheet) opens one page at a time.
	const mode: DeskMode =
		root.width > 0 && roomWidth < NARROW_STAGE ? "single" : "spread";
	const layout = useMemo(() => layoutDesk(passport, mode), [passport, mode]);
	const deskShown = probe?.supported === true && !loading;
	const insets = useMemo(
		() => ({
			bottom: (compact ? 72 : 88) + (deskShown && mode === "single" ? 40 : 0),
			left: 16,
			right: 16 + sheetCover,
			// The act HUD adds a row of buttons and the blind-spot caption.
			top: (compact ? 64 : 92) + (actsOn ? 84 : 0),
		}),
		[actsOn, compact, deskShown, mode, sheetCover]
	);

	// The desk turns two-page spreads on a wide stage; a phone, and the
	// booklet in the sheet, show one page at a time.
	const single = mode === "single" || sheet === "booklet";
	const spreads = useMemo(
		() =>
			single
				? singleSpreads(passport.pages.length)
				: bookletSpreads(passport.pages.length),
		[passport.pages.length, single]
	);

	// Open where the stamps are (the open conversation's, else the first);
	// the cover is a page back.
	const [initialPage] = useState(() => {
		const page = activeThreadId
			? stampPage(passport.pages, activeThreadId)
			: -1;
		return page > 0 ? page : openingPage(passport.pages);
	});
	const {
		finishTurn,
		goToPage,
		goToSpread,
		next,
		page,
		previous,
		spread,
		turn,
	} = usePassportNavigation({
		animate: !(reduceMotion || single),
		initialPage,
		spreads,
	});

	// Follow the open conversation to its page.
	const activePage = activeThreadId
		? stampPage(passport.pages, activeThreadId)
		: -1;
	const lastFollowed = useRef(activeThreadId);
	useEffect(() => {
		if (activeThreadId === lastFollowed.current) {
			return;
		}
		lastFollowed.current = activeThreadId;
		if (activePage > 0) {
			goToPage(activePage);
		}
	}, [activePage, activeThreadId, goToPage]);

	const openStamp = useCallback(
		(threadId: string) => {
			setApplyingTo(null);
			port.openThread(threadId);
		},
		[port]
	);
	const apply = useCallback(
		(agentId: string) => {
			if (recordOpen) {
				port.closeThread();
			}
			setApplyingTo(agentId);
			// The booklet turns to the agent's visa page behind the form.
			const first = countryPage(passport.pages, agentId);
			if (first > 0) {
				goToPage(first);
			}
		},
		[goToPage, passport.pages, port, recordOpen]
	);
	const closePanel = useCallback(() => {
		setApplyingTo(null);
		if (recordOpen) {
			port.closeThread();
		}
	}, [port, recordOpen]);
	const toggleSheet = (next: PassportSheet) => {
		closePanel();
		setSheet((current) => (current === next ? null : next));
	};
	/** A country's row (the list without WebGL): its visa pages, in the booklet. */
	const openCountry = (countryId: string | null) => {
		closePanel();
		setSheet("booklet");
		const first = countryPage(passport.pages, countryId);
		if (first > 0) {
			goToPage(first);
		}
	};

	// Escape files the open record (or drops the application), else closes
	// the booklet or the map, from anywhere in the passport except inside the
	// host's conversation, which owns its keys.
	useEffect(() => {
		if (!anySheet) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			const element = event.target instanceof Node ? event.target : null;
			const inside =
				element === document.body ||
				(element !== null && rootRef.current?.contains(element));
			const inThread =
				element instanceof Element && element.closest("[data-passport-thread]");
			if (!inside || inThread || isEditable(event.target)) {
				return;
			}
			event.preventDefault();
			if (panelOpen) {
				closePanel();
			} else {
				setSheet(null);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [anySheet, closePanel, panelOpen]);

	// The keyboard turns the pages: Page Up and Page Down (and Home, End)
	// from anywhere in the passport but the host's conversation and its
	// forms; the arrow keys too while focus is on the page controls, in the
	// booklet sheet, or nowhere (in the desk they move between plates).
	// Another sheet (the map of travels) keeps its own scrolling: the keys turn
	// the pages only when the booklet or the bare desk is what shows.
	const turnable =
		!panelOpen && (sheet === "booklet" || (deskShown && sheet === null));
	useEffect(() => {
		if (!turnable) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.altKey ||
				event.metaKey ||
				event.ctrlKey ||
				isEditable(event.target) ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			const element = event.target instanceof Element ? event.target : null;
			const onBody = event.target === document.body;
			const inside =
				onBody || (element !== null && rootRef.current?.contains(element));
			if (!inside || element?.closest("[data-passport-thread]")) {
				return;
			}
			const onPages =
				onBody ||
				(element?.closest("[data-passport-booklet], [data-passport-pages]") ??
					null) !== null;
			const paging: Record<string, () => void> = {
				End: () => goToSpread(spreads.length - 1),
				Home: () => goToSpread(0),
				PageDown: next,
				PageUp: previous,
			};
			const arrows: Record<string, () => void> = {
				ArrowLeft: previous,
				ArrowRight: next,
			};
			const action =
				paging[event.key] ?? (onPages ? arrows[event.key] : undefined);
			if (action) {
				event.preventDefault();
				action();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [goToSpread, next, previous, spreads.length, turnable]);

	const countryById = useMemo(
		() => new Map(passport.countries.map((country) => [country.id, country])),
		[passport.countries]
	);

	const renderPage = useCallback(
		(index: number, side: "left" | "right" | "single"): ReactNode => {
			const item = passport.pages[index];
			if (!item) {
				return null;
			}
			switch (item.kind) {
				case "cover":
					return <CoverPage onOpen={() => goToPage(1)} />;
				case "notes":
					return (
						<NotesPage
							agents={snapshot.agents}
							number={item.number}
							side={side}
							upcoming={upcoming}
						/>
					);
				case "identity":
					return (
						<IdentityPage
							number={item.number}
							passport={passport}
							side={side}
						/>
					);
				case "visa":
					return (
						<VisaPage
							activeThreadId={recordOpen ? activeThreadId : null}
							countries={passport.countries}
							onApply={apply}
							onOpen={openStamp}
							page={item}
							side={side}
							totalStamps={
								item.countryId
									? (countryById.get(item.countryId)?.stamps.length ?? 0)
									: passport.unassigned.length
							}
						/>
					);
				default:
					return (
						<BlankPage
							empty={passport.countries.length === 0}
							number={item.number}
							side={side}
						/>
					);
			}
		},
		[
			activeThreadId,
			apply,
			countryById,
			goToPage,
			openStamp,
			passport,
			recordOpen,
			snapshot.agents,
			upcoming,
		]
	);

	const shownSpread = spreads[spread];
	const tabs: BookTab[] = useMemo(
		() =>
			pageTabs(passport, shownSpread).map((tab) => ({
				active: tab.active,
				code: tab.code,
				foil: tab.code === "ID",
				ink: tab.ink === null ? "var(--pp-ink-muted)" : stampInk(tab.ink),
				label: tab.label,
				onSelect: () => goToPage(tab.page),
			})),
		[goToPage, passport, shownSpread]
	);

	// Fit one page (and its tabs) to the sheet's width.
	const bookWidth = PAGE_WIDTH + BOARD * 2 + TAB_ROOM;
	const scale =
		stage.width > 0
			? Math.max(MIN_SCALE, Math.min(MAX_SCALE, (stage.width - 28) / bookWidth))
			: 0.85;

	const activeStamp = findStamp(passport, activeThreadId);
	const activeCountry = activeStamp?.countryId
		? (countryById.get(activeStamp.countryId) ?? null)
		: null;
	const caption = spreadCaption(shownSpread, passport.pages.length);
	let panel: ReactNode = null;
	if (recordOpen) {
		panel = (
			<ImmigrationRecord
				country={activeCountry}
				onClose={closePanel}
				stamp={activeStamp}
				threadView={threadView}
			/>
		);
	} else if (applying) {
		panel = (
			<VisaApplication
				country={applying}
				onCancel={() => setApplyingTo(null)}
				onOpen={openStamp}
				onSubmit={(prompt) => {
					setApplyingTo(null);
					port.startThread({ agentId: applying.id, prompt });
				}}
			/>
		);
	} else if (sheet === "booklet") {
		panel = (
			<GameSheet
				bleed
				closeLabel="Close passport"
				data-passport-booklet=""
				data-testid="passport-booklet"
				eyebrow={`No. ${passport.number}`}
				footer={
					<nav
						aria-label="Pages"
						className="flex items-center justify-between gap-2"
					>
						<GameIconButton
							disabled={spread <= 0}
							label="Previous page"
							onClick={previous}
							title="Previous page (←)"
						>
							<ChevronLeft
								aria-hidden="true"
								className="size-5"
								strokeWidth={2.75}
							/>
						</GameIconButton>
						<p
							aria-live="polite"
							className="gk-display min-w-36 text-center text-[16px] tabular-nums"
						>
							{caption}
						</p>
						<GameIconButton
							disabled={spread >= spreads.length - 1}
							label="Next page"
							onClick={next}
							title="Next page (→)"
						>
							<ChevronRight
								aria-hidden="true"
								className="size-5"
								strokeWidth={2.75}
							/>
						</GameIconButton>
					</nav>
				}
				label="Passport"
				onClose={() => toggleSheet("booklet")}
				title="Passport"
			>
				<div
					className="flex min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden py-3"
					ref={stageRef}
					style={bookletVars}
				>
					<PassportArtProvider>
						<Booklet
							onTurnDone={finishTurn}
							renderPage={renderPage}
							scale={scale}
							single
							smooth={false}
							spreads={spreads}
							tabs={tabs}
							turn={null}
							view={spread}
						/>
					</PassportArtProvider>
				</div>
			</GameSheet>
		);
	} else if (sheet === "map") {
		panel = (
			<GameSheet
				closeLabel="Close the map"
				data-testid="passport-map"
				label="Map of travels"
				onClose={() => toggleSheet("map")}
				title="Map of travels"
			>
				<div
					className="flex min-h-0 flex-1 flex-col overflow-hidden"
					style={bookletVars}
				>
					<PassportArtProvider>
						<TravelMap
							activeThreadId={recordOpen ? activeThreadId : null}
							onApply={apply}
							onOpen={openStamp}
							passport={passport}
						/>
					</PassportArtProvider>
				</div>
			</GameSheet>
		);
	}

	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: headingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const actTotalsNow = actTotals(snapshot, acts);
	const { offStage, onStage } = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				onStage.map((act) => act.agentId)
			),
		[acts, onStage, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const budget = overlayBudget(roomWidth, { domTargets: true });
	const roomy = roomWidth >= ROOMY_DESK;
	const shownKey = [
		...budget.fill(
			actOverlays(
				onStage,
				slots,
				offStage,
				onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
			).filter(
				(item) =>
					deskKeeps(item, layout, { iconOnly: budget.iconOnly, roomy }) &&
					keepsActOverlay(item, kitSettings)
			)
		),
	]
		.sort()
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const actPaths = useMemo(() => deskPaths(layout), [layout]);
	const openAsk = cards.openAsk;
	const officers = useMemo(
		() =>
			actOfficers({
				acts,
				layout,
				looks,
				narrow: budget.iconOnly,
				onAsk: (askId) => openAsk(askId),
				reduced: reduceMotion,
				shown,
			}),
		[acts, budget.iconOnly, layout, looks, openAsk, reduceMotion, shown]
	);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	const actors: DeskActors | undefined = actsOn
		? {
				iconOnly: budget.iconOnly,
				officers,
				paths: actPaths,
				props: (
					<PassportActProps
						acts={acts}
						clock={clock}
						iconOnly={budget.iconOnly}
						layout={layout}
						noteIcons={!roomy}
						nowMs={nowMs}
						offStage={offStage}
						onAsk={(askId) => cards.openAsk(askId)}
						onBlocker={(threadId, agentName) =>
							cards.openBlocker(threadId, agentName)
						}
						onQueue={() => openQueue(queueOpener)}
						onStage={onStage}
						owners={owners}
						paths={actPaths}
						reduced={reduceMotion}
						shown={shown}
						slots={slots}
						snapshot={snapshot}
					/>
				),
			}
		: undefined;
	const totals = `${plural(passport.totals.countries, "country", "countries")} · ${plural(passport.totals.stamps, "stamp", "stamps")} · ${plural(
		passport.totals.travelDays,
		"travel day",
		"travel days"
	)}`;
	const summary = actsOn ? actSummaryLine(actTotalsNow) : totals;

	// The desk's open pages: a spread on a wide stage, one page on a phone,
	// whatever the sheet shows.
	const deskSpreads = useMemo(
		() =>
			mode === "single"
				? singleSpreads(passport.pages.length)
				: bookletSpreads(passport.pages.length),
		[mode, passport.pages.length]
	);
	const deskSpread = deskSpreads[spreadOfPage(deskSpreads, page)];
	const face = (index: number | null | undefined): ReactNode => {
		const item =
			index === null || index === undefined ? null : passport.pages[index];
		if (!item) {
			return null;
		}
		switch (item.kind) {
			case "cover":
				return <CoverFace stamps={passport.totals.stamps} />;
			case "notes":
				return (
					<NotesFace
						agents={snapshot.agents}
						number={item.number}
						upcoming={upcoming}
					/>
				);
			case "identity":
				return (
					<IdentityFace
						number={item.number}
						passport={passport}
						summary={summary}
					/>
				);
			case "visa": {
				const country = item.countryId
					? (countryById.get(item.countryId) ?? null)
					: null;
				return (
					<VisaFace
						activeThreadId={recordOpen ? activeThreadId : null}
						country={country}
						onOpen={openStamp}
						page={item}
						status={visaStatus(
							country,
							actsOn && country ? acts.get(country.agent.id) : undefined
						)}
					/>
				);
			}
			default:
				return (
					<BlankFace
						empty={passport.countries.length === 0}
						number={item.number}
					/>
				);
		}
	};
	const faces = {
		left: face(deskSpread?.left),
		right: face(deskSpread?.right),
	};
	let turning: 1 | -1 | null = null;
	if (turn && !single) {
		turning = turn.to > turn.from ? 1 : -1;
	}
	const framing = deskFraming(layout, root.width, root.height, insets);

	const titlePlate = (
		<GameTitlePlate
			compact={compact}
			icon={<Stamp strokeWidth={2.25} />}
			keepStatus={actsOn}
			status={summary}
			title="Passport"
		/>
	);
	const hud = (
		<>
			<GameHudSlot
				at="top-left"
				className={actsOn ? "right-0 flex-wrap" : "right-0"}
			>
				{actsOn && !loading ? (
					<div className="flex min-w-0 flex-col items-start gap-2">
						{titlePlate}
						<div className="pointer-events-auto flex flex-wrap items-center gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={actTotalsNow}
							/>
							<QueueButton
								acts={acts}
								clock={clock}
								narrow={budget.narrow}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								openRef={queueOpener}
								snapshot={snapshot}
								totals={actTotalsNow}
								unowned={unowned}
							/>
						</div>
						<span className="pointer-events-auto">
							<BlindSpotCaption snapshot={snapshot} />
						</span>
					</div>
				) : (
					titlePlate
				)}
				<div
					aria-label="Passport and map"
					className={cn(
						GAME_PLATE,
						"pointer-events-auto ms-auto flex shrink-0 gap-1 p-1",
						actsOn && "self-start"
					)}
					role="group"
				>
					{(
						[
							["booklet", "Booklet", BookOpen],
							["map", "Map of travels", MapIcon],
						] as const
					).map(([value, label, Icon]) => (
						<button
							aria-label={label}
							aria-pressed={sheet === value && !panelOpen}
							className={cn(
								"gk-display flex h-10 items-center gap-2 rounded-xl px-3 text-[16px] transition-colors hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink)",
								GAME_FOCUS
							)}
							key={value}
							onClick={() => toggleSheet(value)}
							type="button"
						>
							<Icon aria-hidden="true" className="size-5" strokeWidth={2.25} />
							{compact ? null : label}
						</button>
					))}
				</div>
			</GameHudSlot>
			{deskShown && sheet !== "booklet" ? (
				<GameHudSlot
					at="bottom-left"
					// Clear of the zoom controls in the bottom-right corner.
					className="right-[76px]"
				>
					<PageNav
						caption={spreadCaption(deskSpread, passport.pages.length)}
						compact={mode === "single"}
						hasNext={spread < spreads.length - 1}
						hasPrevious={spread > 0}
						onNext={next}
						onPage={goToPage}
						onPrevious={previous}
						tabs={pageTabs(passport, deskSpread)}
					/>
				</GameHudSlot>
			) : null}
			{loading ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);

	return (
		<GameShell
			accent="sky"
			busy={loading}
			data-motion={reduceMotion ? "reduce" : "full"}
			hud={hud}
			label="Passport"
			rootRef={rootRef}
			sheet={panel}
			sheetWidth={sheetWidth}
			testId="interface-passport"
		>
			{/* Focus lands here when an ask or blocker card closes on nothing. */}
			<h1
				className="sr-only"
				ref={headingRef}
				tabIndex={actsOn ? -1 : undefined}
			>
				Passport
			</h1>
			{actsOn && !loading ? (
				<AskQueueList
					acts={acts}
					clock={clock}
					fallbackFocus={headingRef}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					snapshot={snapshot}
					unowned={unowned}
				/>
			) : null}
			<div className="absolute inset-0">
				{loading ? (
					<LoadingIsles />
				) : (
					<IsoStage
						bounds={framing.bounds}
						fallback={
							<PassportList
								acts={
									actsOn
										? {
												sentence: (agentId) =>
													acts.get(agentId)?.ariaLabel ?? null,
												status: (agentId) => {
													const act = acts.get(agentId);
													return act ? (
														<ActStatus
															act={act}
															clock={clock}
															nowMs={nowMs}
															onAsk={onAsk}
															onBlocker={onBlocker}
															snapshot={snapshot}
														/>
													) : null;
												},
											}
										: undefined
								}
								layout={layout}
								onApply={apply}
								onOpenCountry={openCountry}
							/>
						}
						fill={framing.fill}
						insets={insets}
						label="Passport: the booklet open on a desk, a visa page for each agent, whose villager stands on its page's tab. Page Up and Page Down turn the pages; Tab or the arrow keys move between agents; drag to pan, plus and minus to zoom."
						motes={false}
						night={night}
						portrait={framing.portrait}
						reducedMotion={reduceMotion}
						view={isoView}
					>
						{({ theme }) => (
							<DeskScene
								actors={actors}
								art={art}
								customs={
									actsOn ? undefined : <EmptyCustomsDesk layout={layout} />
								}
								faces={faces}
								layout={layout}
								looks={looks}
								onApply={apply}
								onTurnDone={finishTurn}
								pages={passport.pages}
								reducedMotion={reduceMotion}
								spread={deskSpread}
								theme={theme}
								turning={turning}
							/>
						)}
					</IsoStage>
				)}
			</div>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}

/** The countries as a plain list, for stages without WebGL (and tests). */
function PassportList({
	acts,
	layout,
	onApply,
	onOpenCountry,
}: {
	/**
	 * With the act layer: each country's agent row (its Apply button) is
	 * described by the act sentence and followed by its `ActStatus`.
	 */
	acts?: {
		sentence: (agentId: string) => string | null;
		status: (agentId: string) => ReactNode;
	};
	layout: DeskLayout;
	onApply: (agentId: string) => void;
	onOpenCountry: (countryId: string | null) => void;
}) {
	const baseId = useId();
	return (
		<div
			// The act HUD (title, summary, Queue) stands about 205 px tall at
			// phone width: with acts the list starts below it.
			className={
				acts
					? "absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pt-56 pb-28"
					: "absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pt-24 pb-28"
			}
			data-testid="passport-isles"
		>
			<ul className="mx-auto flex max-w-3xl flex-col gap-3">
				{layout.stations.map((station) => (
					<li
						className={cn(GAME_PLATE, "flex flex-wrap items-center gap-2 p-3")}
						key={station.id}
					>
						<button
							aria-label={acts ? countryLabel(station) : stationLabel(station)}
							className={cn(
								GAME_FOCUS,
								"gk-display flex items-center gap-2 rounded-lg px-2 py-1 text-[16px] hover:bg-(--gk-plate-sunk)"
							)}
							onClick={() => onOpenCountry(station.country?.id ?? null)}
							type="button"
						>
							<Stamp aria-hidden="true" className="size-4" />
							{station.country?.agent.name ?? UNASSIGNED_LABEL}
							<span className="text-(--gk-ink-muted) text-[13px] tabular-nums">
								{station.stamps.length}
							</span>
						</button>
						{station.country && acts?.sentence(station.country.agent.id) ? (
							<span
								className="sr-only"
								id={`${baseId}-${station.country.agent.id}`}
							>
								{acts.sentence(station.country.agent.id)}
							</span>
						) : null}
						{station.country ? (
							<button
								aria-describedby={
									acts?.sentence(station.country.agent.id)
										? `${baseId}-${station.country.agent.id}`
										: undefined
								}
								aria-label={`${station.country.agent.name}: apply for a visa`}
								className={cn(
									GAME_FOCUS,
									"rounded-full border-(--gk-plate-sunk) border-2 px-3 py-1 font-semibold text-[13px] hover:bg-(--gk-plate-sunk)"
								)}
								data-act-agent={
									acts?.sentence(station.country.agent.id)
										? station.country.agent.id
										: undefined
								}
								onClick={() => onApply(station.country?.id ?? "")}
								type="button"
							>
								Apply for a visa
							</button>
						) : null}
						{station.country && acts ? (
							<span className="basis-full">
								{acts.status(station.country.agent.id)}
							</span>
						) : null}
					</li>
				))}
			</ul>
			{acts ? null : (
				<p
					className="mx-auto mt-3 flex max-w-3xl items-center gap-2 px-3 text-(--gk-ink-muted) text-[14px]"
					data-customs-empty=""
				>
					<span className="gk-display text-(--gk-ink)">Customs desk</span>
					<span aria-hidden="true">·</span>
					{NO_VISAS_WAITING}
				</p>
			)}
		</div>
	);
}
