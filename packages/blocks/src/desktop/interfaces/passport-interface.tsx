import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import { actSummaryLine, NARROW_STAGE } from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	useGameNight,
	useIsoView,
	useReducedMotion,
	useWebGLProbe,
} from "./game3d-stage.tsx";
import { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAnnouncer, AskQueueList } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { BOARD, type BookTab, TAB_ROOM } from "./passport-booklet.tsx";
import { type DeskMode, deskFraming, layoutDesk } from "./passport-desk.tsx";
import { usePassportActors } from "./passport-interface-acts.tsx";
import { useElementSize } from "./passport-interface-dom.ts";
import { usePassportRenderPage } from "./passport-interface-faces.tsx";
import { useFirstSeen } from "./passport-interface-first-seen.ts";
import { PassportHud } from "./passport-interface-hud.tsx";
import { usePassportKeys } from "./passport-interface-keys.ts";
import { pageTabs, spreadCaption } from "./passport-interface-pages.tsx";
import {
	type PassportSheet,
	passportPanel,
} from "./passport-interface-panel.tsx";
import { passportSettings } from "./passport-interface-settings.ts";
import { PassportStage } from "./passport-interface-stage.tsx";
import {
	bookletSpreads,
	buildPassport,
	countryPage,
	findStamp,
	openingPage,
	plural,
	singleSpreads,
	spreadOfPage,
	stampPage,
	upcomingTravel,
} from "./passport-model.ts";
import { usePassportNavigation } from "./passport-navigation.ts";
import { PAGE_WIDTH } from "./passport-pages.tsx";
import { deskArt, passportVars, stampInk } from "./passport-palette.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

export {
	PageNav,
	type PageTab,
	pageTabs,
	spreadCaption,
	visaStatus,
} from "./passport-interface-pages.tsx";
export { passportSettings } from "./passport-interface-settings.ts";

/** The booklet's page in the sheet never prints smaller than this. */
const MIN_SCALE = 0.6;
const MAX_SCALE = 1.2;

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
	const tl = useLiteralMessages();

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

	// The keyboard turns the pages: Page Up and Page Down (and Home, End)
	// from anywhere in the passport but the host's conversation and its
	// forms; the arrow keys too while focus is on the page controls, in the
	// booklet sheet, or nowhere (in the desk they move between plates).
	// Another sheet (the map of travels) keeps its own scrolling: the keys turn
	// the pages only when the booklet or the bare desk is what shows.
	const turnable =
		!panelOpen && (sheet === "booklet" || (deskShown && sheet === null));
	usePassportKeys({
		anySheet,
		closePanel,
		goToSpread,
		next,
		panelOpen,
		previous,
		rootRef,
		setSheet,
		spreads,
		turnable,
	});

	const countryById = useMemo(
		() => new Map(passport.countries.map((country) => [country.id, country])),
		[passport.countries]
	);

	const renderPage = usePassportRenderPage({
		activeThreadId,
		apply,
		countryById,
		goToPage,
		openStamp,
		passport,
		recordOpen,
		snapshot,
		upcoming,
	});

	const shownSpread = spreads[spread];
	const tabs: BookTab[] = useMemo(
		() =>
			pageTabs(passport, shownSpread, tl).map((tab) => ({
				active: tab.active,
				code: tab.code,
				foil: tab.code === "ID",
				ink: tab.ink === null ? "var(--pp-ink-muted)" : stampInk(tab.ink),
				label: tab.label,
				onSelect: () => goToPage(tab.page),
			})),
		[goToPage, passport, shownSpread, tl]
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
	const caption = spreadCaption(shownSpread, passport.pages.length, tl);
	const panel = passportPanel({
		activeCountry,
		activeStamp,
		activeThreadId,
		apply,
		applying,
		bookletVars,
		caption,
		closePanel,
		finishTurn,
		next,
		openStamp,
		passport,
		port,
		previous,
		recordOpen,
		renderPage,
		scale,
		setApplyingTo,
		sheet,
		spread,
		spreads,
		stageRef,
		tabs,
		threadView,
		toggleSheet,
	});

	const { actors, actTotalsNow, budget, cards, onAsk, onBlocker, queueOpener } =
		usePassportActors({
			acts,
			actsOn,
			clock,
			headingRef,
			kitSettings,
			layout,
			looks,
			nowMs,
			port,
			reduceMotion,
			roomWidth,
			snapshot,
			unowned,
		});
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
	const framing = deskFraming(layout, root.width, root.height, insets);

	const hud = (
		<PassportHud
			acts={acts}
			actsOn={actsOn}
			actTotalsNow={actTotalsNow}
			budget={budget}
			clock={clock}
			compact={compact}
			deskShown={deskShown}
			deskSpread={deskSpread}
			goToPage={goToPage}
			isoView={isoView}
			loading={loading}
			mode={mode}
			next={next}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			panelOpen={panelOpen}
			passport={passport}
			previous={previous}
			queueOpener={queueOpener}
			sheet={sheet}
			snapshot={snapshot}
			spread={spread}
			spreads={spreads}
			summary={summary}
			toggleSheet={toggleSheet}
			unowned={unowned}
		/>
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
				<PassportStage
					activeThreadId={activeThreadId}
					actors={actors}
					acts={acts}
					actsOn={actsOn}
					apply={apply}
					art={art}
					clock={clock}
					countryById={countryById}
					deskSpread={deskSpread}
					finishTurn={finishTurn}
					framing={framing}
					insets={insets}
					isoView={isoView}
					layout={layout}
					loading={loading}
					looks={looks}
					night={night}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					openCountry={openCountry}
					openStamp={openStamp}
					passport={passport}
					recordOpen={recordOpen}
					reduceMotion={reduceMotion}
					single={single}
					snapshot={snapshot}
					summary={summary}
					turn={turn}
					upcoming={upcoming}
				/>
			</div>
			{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
			{cards.element}
		</GameShell>
	);
}
