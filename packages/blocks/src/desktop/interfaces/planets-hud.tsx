import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { ChevronDown, Orbit } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";
import { GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import {
	BodyButton,
	HudStat,
	listFold,
	NeedsYou,
	starMeta,
} from "./planets-hud-rows.tsx";
import {
	PLANET_KIND_LABELS,
	type PlanetSystem,
	planetDescription,
	plural,
} from "./planets-model.ts";
import { STAR_ID } from "./planets-overlay.tsx";
import {
	type PlanetsPalette,
	planetLookIn,
	teamColor,
} from "./planets-palette.ts";
import {
	PlanetSwatch,
	PlanetsStatusDot,
	SunSwatch,
	TeamMark,
} from "./planets-parts.tsx";

export { PlanetsControls } from "./planets-hud-controls.tsx";
export { PlanetsLegend } from "./planets-hud-legend.tsx";

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home"]);

/**
 * The act layer on the system card (when the host sends asks): the act
 * summary in the HUD slot, act counts, and each planet's row named by its
 * act. An asking agent's row answers its ask; the others visit the planet.
 * Every row is a Tab stop, and a folded list stays in the accessibility
 * tree (visually hidden), so each agent keeps a reachable row.
 */
export interface SystemCardActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	onAsk: (askId: string, opener: HTMLElement) => void;
	/** `actSummaryLine(totals)`: "3 need you · 2 working · 1 failed". */
	summary: string;
	totals: Pick<ActTotals, "failed" | "needYou" | "working">;
}

/** A planet row's name with acts: its act sentence and what the row does. */
export function actRowLabel(
	act: InterfaceAgentAct,
	tl: LiteralMessage
): string {
	return act.act === "asking" && act.ask
		? tl("{ariaLabel} Answer their ask.", { ariaLabel: act.ariaLabel })
		: tl("{ariaLabel} Visit their planet.", { ariaLabel: act.ariaLabel });
}

/**
 * Top-left: what the system holds (agents, working, waiting on you) and a
 * list of every body, innermost first. The list is the keyboard way in: one
 * tab stop, arrows move between bodies (the one in focus holds still and is
 * ringed in the scene), Enter visits it. While a thread is open, or the
 * scene is narrower than 1100px and too short to spare the room, the list
 * folds away behind a toggle to free the view.
 */
export function PlanetsSystemCard({
	actLayer = null,
	compact,
	focusId,
	loading,
	onHover,
	onSelect,
	palette,
	roomy,
	sheet = false,
	sheetFooter,
	system,
}: {
	actLayer?: SystemCardActs | null;
	/** Fold the list away (a thread is open beside the scene). */
	compact: boolean;
	focusId: string | null;
	loading: boolean;
	onHover: (bodyId: string | null) => void;
	onSelect: (bodyId: string) => void;
	palette: PlanetsPalette;
	/** The scene is tall enough to keep the list open on a narrower screen. */
	roomy: boolean;
	/**
	 * A phone: the card is a bottom sheet across the screen, folded to its
	 * header (with the counts) until opened; it opens upward.
	 */
	sheet?: boolean;
	/** Shown at the foot of an open sheet (the legend). */
	sheetFooter?: ReactNode;
	system: PlanetSystem;
}) {
	const { summary } = system;
	const tl = useLiteralMessages();
	const listId = useId();
	// The reader's own choice wins; until then the list opens when there is room.
	const [chosen, setChosen] = useState<boolean | null>(null);
	const expanded = chosen ?? (!sheet && roomy && !compact);
	const [cursor, setCursor] = useState(0);
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const bodies = [STAR_ID, ...system.planets.map((planet) => planet.id)];
	const selectedIndex = focusId ? bodies.indexOf(focusId) : -1;
	const tabIndexAt = Math.min(
		selectedIndex === -1 ? cursor : selectedIndex,
		bodies.length - 1
	);

	const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (!NAV_KEYS.has(event.key)) {
			return;
		}
		event.preventDefault();
		const current = buttons.current.indexOf(
			document.activeElement as HTMLButtonElement
		);
		const from = current === -1 ? tabIndexAt : current;
		let next = from;
		if (event.key === "ArrowDown") {
			next = (from + 1) % bodies.length;
		} else if (event.key === "ArrowUp") {
			next = (from - 1 + bodies.length) % bodies.length;
		} else if (event.key === "Home") {
			next = 0;
		} else {
			next = bodies.length - 1;
		}
		setCursor(next);
		buttons.current[next]?.focus();
	};

	return (
		<section
			aria-label="System"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex min-w-0 flex-col overflow-hidden",
				sheet
					? "max-h-[56dvh] w-full"
					: "max-h-full @max-[560px]:w-auto w-[340px]"
			)}
			data-planets-hud="card"
			data-planets-sheet={sheet ? (expanded ? "open" : "folded") : undefined}
		>
			<header className="flex items-center gap-3 py-2 ps-2 pe-3">
				<span
					aria-hidden="true"
					className="grid size-11 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
				>
					<Orbit className="size-6" strokeWidth={2.25} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<h1 className="gk-display text-[24px] leading-7">Planets</h1>
					<p
						className={cn(
							"truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5",
							sheet || actLayer ? null : "@max-[480px]:hidden"
						)}
					>
						{loading ? "Charting your system…" : null}
						{!loading && actLayer ? (
							<span data-act-summary="">{actLayer.summary}</span>
						) : null}
						{!loading && sheet && !actLayer
							? tl(
									"{agents, plural, one {{agents} planet} other {{agents} planets}} · {working} working · {waitingOnYou} for you",
									{
										agents: summary.agents,
										waitingOnYou: summary.waitingOnYou,
										working: summary.working,
									}
								)
							: null}
						{loading || sheet || actLayer ? null : "Your agents in orbit"}
					</p>
				</div>
				<span
					className={cn(
						"shrink-0",
						compact || sheet ? null : "@min-[1100px]:hidden"
					)}
				>
					<GameIconButton
						disabled={loading}
						label={expanded ? "Hide planet list" : "Show planet list"}
						onClick={() => setChosen(!expanded)}
						title={expanded ? "Hide the list" : "Show the list"}
					>
						<ChevronDown
							aria-hidden="true"
							className={cn(
								"size-5 transition-transform motion-reduce:transition-none",
								// A sheet opens upward: its chevron points the way it goes.
								expanded !== sheet && "rotate-180"
							)}
							strokeWidth={2.5}
						/>
						<span className="sr-only">{expanded ? "Hide" : "List"}</span>
					</GameIconButton>
				</span>
			</header>
			<dl
				className="grid @max-[560px]:hidden grid-cols-[auto_auto_minmax(0,1fr)] border-(--gk-plate-sunk) border-y-2"
				data-testid="planets-summary"
			>
				{actLayer ? (
					<>
						<HudStat
							label="Need you"
							loading={loading}
							tone={
								actLayer.totals.needYou > 0
									? "text-(--planets-turn)"
									: undefined
							}
							value={actLayer.totals.needYou}
						/>
						<HudStat
							label="Working"
							loading={loading}
							tone={
								actLayer.totals.working > 0 ? "text-(--gk-good)" : undefined
							}
							value={actLayer.totals.working}
						/>
						<HudStat
							label="Failed"
							loading={loading}
							tone={actLayer.totals.failed > 0 ? "text-(--gk-bad)" : undefined}
							value={actLayer.totals.failed}
						/>
					</>
				) : (
					<>
						<HudStat label="Agents" loading={loading} value={summary.agents} />
						<HudStat
							label="Working"
							loading={loading}
							tone={summary.working > 0 ? "text-(--gk-good)" : undefined}
							value={summary.working}
						/>
						<HudStat
							label="Waiting on you"
							loading={loading}
							tone={
								summary.waitingOnYou > 0 ? "text-(--planets-turn)" : undefined
							}
							value={summary.waitingOnYou}
						/>
					</>
				)}
			</dl>
			{loading ? (
				<div aria-hidden="true" className="flex flex-col gap-2.5 p-3.5">
					{[0, 1, 2, 3].map((row) => (
						<div className="flex items-center gap-2.5" key={row}>
							<Skeleton className="size-5" radius="pill" />
							<Skeleton className="h-3 flex-1" radius="pill" />
						</div>
					))}
				</div>
			) : (
				<ul
					aria-label="Bodies in orbit, innermost first"
					className={cn(
						"flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain p-1.5 [scrollbar-width:thin]",
						listFold(actLayer !== null, expanded, compact || sheet)
					)}
					data-agent-list={actLayer ? "" : undefined}
					id={listId}
					onKeyDown={onListKeyDown}
				>
					<li>
						<BodyButton
							active={focusId === STAR_ID}
							description={tl(
								"You, the star. {waitingOnYou, plural, one {{waitingOnYou} thread} other {{waitingOnYou} threads}} waiting on you",
								{ waitingOnYou: summary.waitingOnYou }
							)}
							meta={
								<>
									<NeedsYou
										attention={summary.attention}
										trailing={summary.waitingOnYou === 0}
										yourTurn={summary.yourTurn}
									/>
									{summary.waitingOnYou > 0 ? null : starMeta(system)}
								</>
							}
							name="You"
							onBlur={() => onHover(null)}
							onClick={() => onSelect(STAR_ID)}
							onFocus={() => {
								setCursor(0);
								onHover(STAR_ID);
							}}
							ref={(element) => {
								buttons.current[0] = element;
							}}
							swatch={<SunSwatch className="size-5" palette={palette} />}
							tabbable={actLayer !== null || tabIndexAt === 0}
							trailing={null}
						/>
					</li>
					{system.planets.map((planet, index) => {
						const team = system.teams.find((item) => item.id === planet.teamId);
						const act = actLayer?.acts.get(planet.id);
						const ask = act?.act === "asking" ? act.ask : null;
						const needsYou =
							planet.counts.attention + planet.counts["your-turn"];
						return (
							<li key={planet.id}>
								<BodyButton
									act={
										act ? { agentId: planet.id, asking: ask !== null } : null
									}
									active={focusId === planet.id}
									description={
										act ? actRowLabel(act, tl) : planetDescription(planet)
									}
									meta={
										<>
											<NeedsYou
												attention={planet.counts.attention}
												yourTurn={planet.counts["your-turn"]}
											/>
											{needsYou > 0
												? plural(planet.threadCount, "moon")
												: `${PLANET_KIND_LABELS[planet.kind]} · ${plural(planet.threadCount, "moon")}`}
										</>
									}
									name={planet.name}
									onBlur={() => onHover(null)}
									onClick={(event) => {
										if (ask && actLayer) {
											actLayer.onAsk(ask.id, event.currentTarget);
											return;
										}
										onSelect(planet.id);
									}}
									onFocus={() => {
										setCursor(index + 1);
										onHover(planet.id);
									}}
									ref={(element) => {
										buttons.current[index + 1] = element;
									}}
									swatch={
										<PlanetSwatch
											className="size-5"
											look={planetLookIn(system, planet.id)}
											planet={planet}
										/>
									}
									tabbable={actLayer !== null || tabIndexAt === index + 1}
									team={
										team ? (
											<TeamMark color={teamColor(palette, team.colorIndex)} />
										) : null
									}
									trailing={
										planet.working ? (
											<span className="flex items-center gap-1.5 font-medium text-[12px] text-status-success">
												<PlanetsStatusDot
													className="size-1.5"
													status="working"
												/>
												Working
											</span>
										) : null
									}
								/>
							</li>
						);
					})}
				</ul>
			)}
			{sheet && expanded && sheetFooter ? (
				<div className="shrink-0 border-(--gk-plate-sunk) border-t-2">
					{sheetFooter}
				</div>
			) : null}
		</section>
	);
}
