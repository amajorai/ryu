import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	Activity,
	Lightbulb,
	type LucideIcon,
	MessageCircle,
	Newspaper,
	Target,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { PersonaAvatar } from "./persona-avatar.tsx";
import {
	PERSONA_TAB_LABELS,
	PERSONA_TABS,
	type PersonaTab,
} from "./persona-model.ts";

const TAB_ICONS: Record<PersonaTab, LucideIcon> = {
	activity: Activity,
	chat: MessageCircle,
	feed: Newspaper,
	goals: Target,
	ideas: Lightbulb,
};

export interface PersonaTabBadges {
	/** Threads failing or stopped: shown on Activity. */
	attention: number;
	/** The persona's replies waiting on you: shown on Chat. */
	unread: number;
}

export function personaTabId(tab: PersonaTab): string {
	return `persona-tab-${tab}`;
}

export function personaPanelId(tab: PersonaTab): string {
	return `persona-panel-${tab}`;
}

/** Arrow keys (either axis), Home and End move between tabs and select them. */
function onTabKeyDown(
	event: KeyboardEvent<HTMLElement>,
	tab: PersonaTab,
	onSelect: (tab: PersonaTab) => void
) {
	const index = PERSONA_TABS.indexOf(tab);
	let next: number | null = null;
	if (event.key === "ArrowDown" || event.key === "ArrowRight") {
		next = (index + 1) % PERSONA_TABS.length;
	} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
		next = (index - 1 + PERSONA_TABS.length) % PERSONA_TABS.length;
	} else if (event.key === "Home") {
		next = 0;
	} else if (event.key === "End") {
		next = PERSONA_TABS.length - 1;
	}
	const target = next === null ? undefined : PERSONA_TABS[next];
	if (!target) {
		return;
	}
	event.preventDefault();
	onSelect(target);
	const list = event.currentTarget.closest('[role="tablist"]');
	list?.querySelector<HTMLElement>(`[data-persona-tab="${target}"]`)?.focus();
}

function badgeFor(tab: PersonaTab, badges: PersonaTabBadges): number {
	if (tab === "chat") {
		return badges.unread;
	}
	if (tab === "activity") {
		return badges.attention;
	}
	return 0;
}

function badgeLabel(
	tl: LiteralMessage,
	tab: PersonaTab,
	count: number
): string {
	const countText = String(count);
	return tab === "chat"
		? tl(
				"{count, plural, one {{countText} reply} other {{countText} replies}} waiting on you",
				{ count, countText }
			)
		: tl(
				"{count, plural, one {{countText} needs} other {{countText} need}} attention",
				{ count, countText }
			);
}

/**
 * Desktop navigation: the five sections, then the agents you can switch to.
 * Collapses to an icon rail between 640px and 1024px; below that the bottom
 * tab bar takes over.
 */
export function PersonaRail({
	agents,
	badges,
	headlines,
	onSelectPersona,
	onSelectTab,
	personaId,
	tab,
}: {
	agents: InterfaceAgent[];
	badges: PersonaTabBadges;
	headlines: Map<string, string>;
	onSelectPersona: (agentId: string) => void;
	onSelectTab: (tab: PersonaTab) => void;
	personaId: string | null;
	tab: PersonaTab;
}) {
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label="Persona"
			className="@min-[640px]:flex hidden @min-[1024px]:w-60 w-16 shrink-0 flex-col gap-6 overflow-y-auto border-sidebar-border border-r bg-sidebar px-3 py-4 text-sidebar-foreground"
		>
			<div
				aria-orientation="vertical"
				className="flex flex-col gap-0.5"
				role="tablist"
			>
				{PERSONA_TABS.map((item) => {
					const Icon = TAB_ICONS[item];
					const selected = item === tab;
					const count = badgeFor(item, badges);
					return (
						<button
							aria-controls={personaPanelId(item)}
							aria-label={
								count > 0
									? `${PERSONA_TAB_LABELS[item]}, ${badgeLabel(tl, item, count)}`
									: PERSONA_TAB_LABELS[item]
							}
							aria-selected={selected}
							className={cn(
								"relative flex h-9 items-center @min-[1024px]:justify-start justify-center gap-3 rounded-lg @min-[1024px]:px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								selected
									? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
									: "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
							)}
							data-persona-tab={item}
							id={personaTabId(item)}
							key={item}
							onClick={() => onSelectTab(item)}
							onKeyDown={(event) => onTabKeyDown(event, item, onSelectTab)}
							role="tab"
							tabIndex={selected ? 0 : -1}
							title={PERSONA_TAB_LABELS[item]}
							type="button"
						>
							<span className="relative flex shrink-0">
								<Icon aria-hidden="true" className="size-4" />
								{count > 0 ? (
									<span
										aria-hidden="true"
										className={cn(
											"absolute -top-0.5 -right-0.5 @min-[1024px]:hidden size-2 rounded-full bg-primary ring-2",
											selected ? "ring-sidebar-accent" : "ring-sidebar"
										)}
									/>
								) : null}
							</span>
							<span className="@min-[1024px]:inline hidden flex-1 text-left">
								{PERSONA_TAB_LABELS[item]}
							</span>
							{count > 0 ? (
								<span
									aria-hidden="true"
									className="@min-[1024px]:flex hidden h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[11px] text-primary-foreground tabular-nums"
								>
									{count}
								</span>
							) : null}
						</button>
					);
				})}
			</div>
			{agents.length > 0 ? (
				<section
					aria-labelledby="persona-rail-agents"
					className="flex flex-col"
				>
					<h2
						className="@min-[1024px]:flex hidden items-baseline justify-between px-2.5 pb-2 font-medium text-muted-foreground text-xs"
						id="persona-rail-agents"
					>
						Personas
						<span className="font-normal tabular-nums">{agents.length}</span>
					</h2>
					<h2 className="sr-only @min-[1024px]:hidden">Personas</h2>
					<ul className="flex flex-col gap-0.5">
						{agents.map((agent) => {
							const selected = agent.id === personaId;
							const headline = headlines.get(agent.id) ?? "";
							return (
								<li key={agent.id}>
									<button
										aria-current={selected ? "true" : undefined}
										aria-label={`${agent.name}${agent.status === "working" ? ", working" : ""}. ${headline}`}
										className={cn(
											"flex w-full items-center @min-[1024px]:justify-start justify-center gap-3 rounded-lg @min-[1024px]:px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
											selected
												? "bg-sidebar-accent text-sidebar-accent-foreground"
												: "hover:bg-sidebar-accent/60"
										)}
										onClick={() => onSelectPersona(agent.id)}
										title={agent.name}
										type="button"
									>
										<PersonaAvatar
											agent={agent}
											showPresence
											size={40}
											surface={selected ? "sidebar-accent" : "sidebar"}
										/>
										<span className="@min-[1024px]:flex hidden min-w-0 flex-1 flex-col">
											<span className="flex items-baseline gap-2">
												<span className="truncate font-semibold text-sm">
													{agent.name}
												</span>
												{agent.status === "working" ? (
													<span className="shrink-0 text-success text-xs">
														working
													</span>
												) : null}
											</span>
											<span
												className={cn(
													"truncate text-xs",
													selected
														? "text-sidebar-accent-foreground/75"
														: "text-muted-foreground"
												)}
											>
												{headline}
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
		</nav>
	);
}

/** Phone-width navigation: a bottom tab bar, like a messaging app. */
export function PersonaTabBar({
	badges,
	onSelectTab,
	tab,
}: {
	badges: PersonaTabBadges;
	onSelectTab: (tab: PersonaTab) => void;
	tab: PersonaTab;
}) {
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label="Persona sections"
			className="@min-[640px]:hidden shrink-0 border-border border-t bg-background"
		>
			<div className="grid grid-cols-5" role="tablist">
				{PERSONA_TABS.map((item) => {
					const Icon = TAB_ICONS[item];
					const selected = item === tab;
					const count = badgeFor(item, badges);
					return (
						<button
							aria-controls={personaPanelId(item)}
							aria-label={
								count > 0
									? `${PERSONA_TAB_LABELS[item]}, ${badgeLabel(tl, item, count)}`
									: PERSONA_TAB_LABELS[item]
							}
							aria-selected={selected}
							className={cn(
								"flex h-14 flex-col items-center justify-center gap-1 font-medium text-[11px] outline-none transition-colors focus-visible:bg-muted",
								selected ? "text-foreground" : "text-muted-foreground"
							)}
							data-persona-tab={item}
							key={item}
							onClick={() => onSelectTab(item)}
							onKeyDown={(event) => onTabKeyDown(event, item, onSelectTab)}
							role="tab"
							tabIndex={selected ? 0 : -1}
							type="button"
						>
							<span className="relative">
								<Icon
									aria-hidden="true"
									className="size-5"
									strokeWidth={selected ? 2.25 : 2}
								/>
								{count > 0 ? (
									<span
										aria-hidden="true"
										className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground tabular-nums ring-2 ring-background"
									>
										{count}
									</span>
								) : null}
							</span>
							{PERSONA_TAB_LABELS[item]}
						</button>
					);
				})}
			</div>
		</nav>
	);
}
