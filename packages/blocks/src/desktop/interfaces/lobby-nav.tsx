import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Gamepad2 } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import {
	formatXp,
	LOBBY_TAB_LABELS,
	LOBBY_TABS,
	type LobbyLevel,
	type LobbyTab,
} from "./lobby-model.ts";
import { DISPLAY } from "./lobby-parts.tsx";

export function lobbyTabId(tab: LobbyTab): string {
	return `lobby-tab-${tab}`;
}

export function lobbyPanelId(tab: LobbyTab): string {
	return `lobby-panel-${tab}`;
}

const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * The HUD: the game's plate top left (the accent icon, then the four menu
 * tabs in heavy caps), and the account level with its XP bar top right, the
 * way a battle pass shows it.
 */
export function LobbyNav({
	badges,
	compact,
	level,
	loading,
	onTab,
	tab,
}: {
	/** A count shown on a tab (things ready to claim). */
	badges: Partial<Record<LobbyTab, number>>;
	/** Narrow stages: smaller tabs, the level as its badge only. */
	compact: boolean;
	level: LobbyLevel;
	loading: boolean;
	onTab: (tab: LobbyTab) => void;
	tab: LobbyTab;
}) {
	const tl = useLiteralMessages();
	const listRef = useRef<HTMLDivElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = LOBBY_TABS.indexOf(tab);
		let next: number | undefined;
		if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = LOBBY_TABS.length - 1;
		} else if (STEP[event.key] !== undefined) {
			next =
				(index + (STEP[event.key] ?? 0) + LOBBY_TABS.length) %
				LOBBY_TABS.length;
		}
		const target = next === undefined ? undefined : LOBBY_TABS[next];
		if (!target) {
			return;
		}
		event.preventDefault();
		onTab(target);
		listRef.current
			?.querySelector<HTMLElement>(`#${lobbyTabId(target)}`)
			?.focus();
	};
	const xpLabel = `${formatXp(level.progress)} / ${formatXp(level.span)} XP`;
	return (
		<>
			<GameHudSlot at="top-left" className="min-w-0 max-w-[calc(100%-7rem)]">
				<nav
					aria-label="Lobby"
					className={cn(
						GAME_PLATE,
						"pointer-events-auto flex min-w-0 items-center gap-3 overflow-x-auto [scrollbar-width:none]",
						compact ? "h-12 px-3.5" : "h-[60px] ps-2 pe-5"
					)}
				>
					{compact ? null : (
						<span
							aria-hidden="true"
							className="grid size-11 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink) [&_svg]:size-6"
						>
							<Gamepad2 strokeWidth={2.5} />
						</span>
					)}
					<div
						aria-label="Lobby menu"
						className={cn(
							"flex min-w-0 items-stretch self-stretch",
							compact ? "gap-3" : "gap-6"
						)}
						onKeyDown={onKeyDown}
						ref={listRef}
						role="tablist"
					>
						{LOBBY_TABS.map((option) => {
							const selected = option === tab;
							const badge = badges[option] ?? 0;
							return (
								<button
									aria-controls={lobbyPanelId(option)}
									aria-selected={selected}
									className={cn(
										"group/tab relative flex shrink-0 items-center gap-1.5 outline-none",
										DISPLAY,
										compact ? "pt-0.5 text-[18px]" : "pt-0.5 text-[25px]",
										"transition-colors duration-150",
										selected
											? "text-(--gk-ink)"
											: "text-(--gk-ink-soft) hover:text-(--gk-ink-muted)"
									)}
									id={lobbyTabId(option)}
									key={option}
									onClick={() => onTab(option)}
									role="tab"
									tabIndex={selected ? 0 : -1}
									type="button"
								>
									<span
										aria-hidden="true"
										className="absolute -inset-x-2 inset-y-2 rounded-md opacity-0 outline-(--gk-focus) outline-3 outline-solid group-focus-visible/tab:opacity-100"
									/>
									<span>{LOBBY_TAB_LABELS[option]}</span>
									{badge > 0 ? (
										<span className="gk-display -mt-1 flex h-5 min-w-5 items-center justify-center rounded-full border-(--gk-edge) border-2 bg-(--gk-bad) px-1 text-[11px] text-white tabular-nums tracking-normal">
											{badge}
											<span className="sr-only"> ready to claim</span>
										</span>
									) : null}
									<span
										aria-hidden="true"
										className={cn(
											"absolute inset-x-0 bottom-1.5 h-1 rounded-full bg-(--gk-accent) transition-transform duration-200 ease-out motion-reduce:transition-none",
											selected ? "scale-x-100" : "scale-x-0"
										)}
									/>
								</button>
							);
						})}
					</div>
				</nav>
			</GameHudSlot>
			<GameHudSlot at="top-right">
				<div
					aria-label={
						loading
							? "Level loading"
							: tl("Level {level}, {xpLabel} to level {nextLevel}", {
									level: String(level.level),
									xpLabel,
									nextLevel: String(level.level + 1),
								})
					}
					className={cn(
						GAME_PLATE,
						"pointer-events-auto flex shrink-0 items-center gap-3",
						compact ? "h-12 ps-1.5 pe-1.5" : "h-[60px] ps-2 pe-5"
					)}
					role="group"
				>
					<span
						aria-hidden="true"
						className={cn(
							"gk-display grid shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-gold) text-(--gk-edge) tabular-nums",
							compact ? "size-9 text-[18px]" : "size-11 text-[22px]"
						)}
					>
						{loading ? "–" : level.level}
					</span>
					{compact ? null : (
						<div aria-hidden="true" className="flex w-44 flex-col gap-1.5">
							<div className="flex items-baseline justify-between gap-2">
								<span className="font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide">
									{tl("Level {level}", {
										level: loading ? "" : String(level.level),
									})}
								</span>
								<span className="font-semibold text-(--gk-ink-muted) text-[12px] tabular-nums leading-4">
									{loading ? "" : xpLabel}
								</span>
							</div>
							<div className="h-2.5 overflow-hidden rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
								<div
									className="h-full rounded-full bg-(--gk-accent) transition-[width] duration-500 ease-out motion-reduce:transition-none"
									style={{
										width: `${loading || level.span <= 0 ? 0 : Math.min(100, (level.progress / level.span) * 100)}%`,
									}}
								/>
							</div>
						</div>
					)}
				</div>
			</GameHudSlot>
		</>
	);
}
