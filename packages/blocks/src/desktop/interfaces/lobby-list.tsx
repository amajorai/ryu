import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	type LobbyMember,
	SQUAD_SIZE,
	SQUAD_STATE_DESCRIPTIONS,
	threadTitle,
} from "./lobby-model.ts";
import { LobbyHead, LobbyStateChip, STATUS_DOT } from "./lobby-parts.tsx";

/**
 * The LOBBY tab without WebGL (and in tests): the plaza's same controls as a
 * plain, keyboard-usable column of kit plates: the dailies and the squad
 * summary, the squad as a radio group, and the squad's recent matches.
 */

const NAV_KEYS: Record<string, number> = {
	ArrowDown: 1,
	ArrowLeft: -1,
	ArrowRight: 1,
	ArrowUp: -1,
};

/** A squad member's row: their head, name, state and level. */
function MemberRow({
	describedBy,
	member,
	onSelect,
	selected,
	tabStop,
}: {
	/**
	 * The id of the member's act sentence: with the act layer the row is
	 * described by it, and drops its own state words, chip and colours.
	 */
	describedBy?: string;
	member: LobbyMember;
	onSelect: () => void;
	selected: boolean;
	/** The group's one Tab stop (the selected row, else the first). */
	tabStop: boolean;
}) {
	const tl = useLiteralMessages();
	const { agent, level, state } = member;
	const acted = describedBy !== undefined;
	return (
		<button
			aria-checked={selected}
			aria-describedby={describedBy}
			aria-label={
				acted
					? tl("{name}, level {level}", {
							name: agent.name,
							level: String(level.level),
						})
					: tl("{name}, {stateDescription}, level {level}", {
							name: agent.name,
							stateDescription: SQUAD_STATE_DESCRIPTIONS[state],
							level: String(level.level),
						})
			}
			className={cn(
				GAME_FOCUS,
				"flex h-12 w-full items-center gap-3 rounded-xl px-2 text-start transition-colors hover:bg-(--gk-plate-sunk)",
				selected && "bg-(--gk-plate-sunk)"
			)}
			data-agent-id={agent.id}
			onClick={onSelect}
			role="radio"
			tabIndex={tabStop ? 0 : -1}
			type="button"
		>
			<LobbyHead agent={agent} state={acted ? "ready" : state} />
			<span className="gk-display min-w-0 flex-1 truncate text-[17px]">
				{agent.name}
			</span>
			{acted ? null : <LobbyStateChip state={state} />}
			<span className="gk-display w-12 shrink-0 text-end text-[14px] tabular-nums">
				Lv {level.level}
			</span>
		</button>
	);
}

/** The act layer's words for a member's row: its sentence and status line. */
export interface LobbyRowActs {
	/** The agents off the podium, as a list with their status lines. */
	offStage: ReactNode;
	/** The member's act sentence (described by its row) and status line. */
	row: (agentId: string) => { label: string; status: ReactNode } | null;
	/** Where the act HUD ends (px from the stage's top), to start the list below it. */
	top?: number;
}

/** The squad: a radio group, arrows move the selection. */
function Squad({
	acts,
	onInvite,
	onSelect,
	selectedId,
	size,
	squad,
}: {
	acts?: LobbyRowActs;
	onInvite: () => void;
	onSelect: (agentId: string) => void;
	selectedId: string | undefined;
	/** The squad's size (the "Squad size" setting). */
	size: number;
	squad: LobbyMember[];
}) {
	const groupRef = useRef<HTMLDivElement>(null);
	const baseId = useId();
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = NAV_KEYS[event.key];
		if (step === undefined || squad.length === 0) {
			return;
		}
		event.preventDefault();
		// From the selected radio, or the group's Tab stop (the first) when
		// the selection is a benched pick.
		const index = Math.max(
			0,
			squad.findIndex((member) => member.agent.id === selectedId)
		);
		const next = squad[(index + step + squad.length) % squad.length];
		if (!next) {
			return;
		}
		onSelect(next.agent.id);
		const radios =
			groupRef.current?.querySelectorAll<HTMLElement>("[data-agent-id]") ?? [];
		for (const radio of radios) {
			if (radio.dataset.agentId === next.agent.id) {
				radio.focus();
			}
		}
	};
	const openSlots = Math.max(0, size - squad.length);
	const selectedInSquad = squad.some(
		(member) => member.agent.id === selectedId
	);
	return (
		<section
			aria-label="Squad on the podium"
			className={cn(GAME_PLATE, "flex flex-col gap-1 p-2")}
		>
			<div
				aria-label="Squad"
				className="flex flex-col gap-1"
				onKeyDown={onKeyDown}
				ref={groupRef}
				role="radiogroup"
			>
				{squad.map((member, index) => {
					const row = acts?.row(member.agent.id) ?? null;
					const selected = member.agent.id === selectedId;
					return (
						<MemberRow
							describedBy={row ? `${baseId}-act-${member.agent.id}` : undefined}
							key={member.agent.id}
							member={member}
							onSelect={() => onSelect(member.agent.id)}
							selected={selected}
							// A benched pick (not in the squad) still leaves one Tab stop.
							tabStop={selected || (!selectedInSquad && index === 0)}
						/>
					);
				})}
			</div>
			{acts ? (
				// Outside the radio group, whose arrow keys move the selection.
				<ul aria-label="Squad status" className="flex flex-col gap-1 px-2">
					{squad.map((member) => {
						const row = acts.row(member.agent.id);
						return row ? (
							<li
								className="flex flex-wrap items-center gap-2"
								data-agent-status={member.agent.id}
								key={member.agent.id}
							>
								<span
									className="sr-only"
									id={`${baseId}-act-${member.agent.id}`}
								>
									{row.label}
								</span>
								<span className="gk-display text-[14px]">
									{member.agent.name}
								</span>
								{row.status}
							</li>
						) : null;
					})}
				</ul>
			) : null}
			{Array.from({ length: openSlots }, (_, index) => (
				<button
					aria-label="Open slot: add an agent from the squad roster"
					className={cn(
						GAME_FOCUS,
						"gk-display flex h-12 w-full items-center rounded-xl border-(--gk-edge)/30 border-2 border-dashed px-3 text-(--gk-ink-muted) text-[15px] hover:bg-(--gk-plate-sunk)"
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: open slots have no identity.
					key={`slot-${index}`}
					onClick={onInvite}
					type="button"
				>
					+ Open slot
				</button>
			))}
		</section>
	);
}

/** The squad's latest threads, as recent matches. */
function RecentMatches({
	acted = false,
	activeThreadId,
	members,
	now,
	onOpen,
	selected,
	threads,
	waiting,
}: {
	/** With the act layer: plain shortcuts (what waits is the queue's). */
	acted?: boolean;
	activeThreadId: string | null;
	members: readonly LobbyMember[];
	now: number;
	onOpen: (threadId: string) => void;
	selected: LobbyMember | undefined;
	threads: readonly InterfaceThread[];
	waiting: number;
}) {
	const tl = useLiteralMessages();
	const lead = (thread: InterfaceThread) =>
		members.find((member) => member.agent.id === thread.agentIds[0])?.agent;
	return (
		<section
			aria-label="Squad's recent matches"
			className={cn(GAME_PLATE, "flex flex-col gap-2 px-4 pt-3 pb-2")}
		>
			<div className="flex items-baseline gap-3">
				<h2 className="gk-display text-[19px] leading-6">Recent matches</h2>
				{acted ? null : (
					<p className="truncate font-semibold text-(--gk-ink-muted) text-[13px] tabular-nums leading-5">
						{tl("{waiting} waiting on you", { waiting: String(waiting) })}
					</p>
				)}
			</div>
			{threads.length === 0 ? (
				<p className="py-3 font-medium text-(--gk-ink-muted) text-[14px]">
					No matches with your squad yet.
				</p>
			) : (
				<ul className="flex flex-col">
					{threads.map((thread) => {
						const status = threadStatus(thread);
						const title = threadTitle(thread);
						const open = thread.id === activeThreadId;
						const agent = lead(thread);
						return (
							<li
								className="border-(--gk-plate-sunk) border-t-2 first:border-t-0"
								key={thread.id}
							>
								<button
									aria-current={open ? "true" : undefined}
									aria-label={`${title}${agent ? ` with ${agent.name}` : ""}${acted ? "" : `, ${THREAD_STATUS_LABELS[status]}`}. ${open ? "Open now." : "Open thread."}`}
									className={cn(
										"group/match relative flex h-10 w-full items-center gap-3 text-start outline-none before:absolute before:-inset-x-2 before:inset-y-0.5 before:rounded-lg before:transition-colors hover:before:bg-(--gk-plate-sunk) focus-visible:before:outline-(--gk-focus) focus-visible:before:outline-3 focus-visible:before:outline-solid",
										open && "before:bg-(--gk-plate-sunk)"
									)}
									data-thread-id={thread.id}
									onClick={() => onOpen(thread.id)}
									type="button"
								>
									{acted ? null : (
										<span
											aria-hidden="true"
											className={cn(
												"relative size-2 shrink-0 rounded-full",
												STATUS_DOT[status]
											)}
										/>
									)}
									<span className="relative min-w-0 flex-1 truncate font-semibold text-(--gk-ink) text-[14px]">
										{title}
									</span>
									{agent ? (
										<span
											className={cn(
												"relative shrink-0 text-[13px] leading-4",
												agent.id === selected?.agent.id
													? "font-bold text-(--gk-ink)"
													: "font-medium text-(--gk-ink-muted)"
											)}
										>
											{agent.name}
										</span>
									) : null}
									{acted ? null : (
										<span className="relative shrink-0 font-medium text-(--gk-ink-muted) text-[13px] tabular-nums">
											{compactAge(thread.updatedAt, now)}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

export function LobbyList({
	acts,
	activeThreadId,
	members,
	now,
	onInvite,
	onOpen,
	onSelect,
	onShowQuests,
	ready,
	selected,
	size = SQUAD_SIZE,
	squad,
	threads,
	waiting,
}: {
	/** The act layer's rows (a snapshot with `asks`). */
	acts?: LobbyRowActs;
	activeThreadId: string | null;
	members: readonly LobbyMember[];
	now: number;
	onInvite: () => void;
	onOpen: (threadId: string) => void;
	onSelect: (agentId: string) => void;
	onShowQuests: () => void;
	ready: number;
	selected: LobbyMember | undefined;
	/** The squad's size (the "Squad size" setting). */
	size?: number;
	squad: LobbyMember[];
	threads: readonly InterfaceThread[];
	waiting: number;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			className={cn(
				"absolute inset-0 overflow-y-auto overscroll-contain",
				// The act layer's HUD (summary, caption, buttons) sits under the menu.
				acts
					? "@max-[759px]/game:pt-[200px] pt-[176px]"
					: "@max-[759px]/game:pt-[68px] pt-[88px]"
			)}
			style={acts?.top ? { paddingTop: acts.top + 12 } : undefined}
		>
			<div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 px-4 pb-64">
				<div className="flex items-start justify-between gap-3">
					<button
						aria-label={tl(
							"Daily quests, {ready} ready to claim. Open the quest board.",
							{ ready: String(ready) }
						)}
						className={cn(
							GAME_PLATE,
							GAME_FOCUS,
							"gk-display flex h-14 min-w-0 items-center gap-3 ps-2 pe-4 text-[17px] transition-colors hover:bg-(--gk-plate-sunk)"
						)}
						onClick={onShowQuests}
						type="button"
					>
						<span
							aria-hidden="true"
							className="grid size-10 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-warn) text-(--gk-edge) text-[18px] tabular-nums"
						>
							{ready}
						</span>
						Daily quests
						<ArrowRight aria-hidden="true" className="size-4 shrink-0" />
					</button>
					<button
						aria-label={tl("Squad {count} of {size}. Edit squad.", {
							count: String(squad.length),
							size: String(size),
						})}
						className={cn(
							GAME_PLATE,
							GAME_FOCUS,
							"gk-display flex h-14 shrink-0 items-center gap-2 px-4 text-[17px] transition-colors hover:bg-(--gk-plate-sunk)"
						)}
						onClick={onInvite}
						type="button"
					>
						<span className="tabular-nums">
							{tl("Squad {count}/{size}", {
								count: String(squad.length),
								size: String(size),
							})}
						</span>
						<span aria-hidden="true" className="text-(--gk-ink-muted)">
							·
						</span>
						Edit
					</button>
				</div>
				<Squad
					acts={acts}
					onInvite={onInvite}
					onSelect={onSelect}
					selectedId={selected?.agent.id}
					size={size}
					squad={squad}
				/>
				{acts?.offStage}
				<RecentMatches
					acted={acts !== undefined}
					activeThreadId={activeThreadId}
					members={members}
					now={now}
					onOpen={onOpen}
					selected={selected}
					threads={threads}
					waiting={waiting}
				/>
			</div>
		</div>
	);
}
