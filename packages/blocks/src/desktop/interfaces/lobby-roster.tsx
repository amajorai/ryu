import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowRight } from "lucide-react";
import { type LobbyMember, SQUAD_STATE_DESCRIPTIONS } from "./lobby-model.ts";
import { FIGURE_SHADOW, TILE_BACKDROP } from "./lobby-palette.ts";
import {
	DISPLAY,
	KICKER,
	LobbyFigure,
	LobbyStateChip,
} from "./lobby-parts.tsx";

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex min-w-12 flex-col gap-1">
			<dt className={cn(KICKER, "order-2 text-(--gk-ink-muted) text-[10px]")}>
				{label}
			</dt>
			<dd
				className={cn(
					DISPLAY,
					"order-1 text-(--gk-ink) text-[24px] tabular-nums"
				)}
			>
				{value}
			</dd>
		</div>
	);
}

function RosterCard({
	actLabel,
	inSquad,
	leading,
	member,
	onPick,
}: {
	/**
	 * The agent's act sentence (with the act layer): it names the card in
	 * place of the legacy state, which then shows no chip.
	 */
	actLabel?: string;
	inSquad: boolean;
	leading: boolean;
	member: LobbyMember;
	onPick: () => void;
}) {
	const { agent, level } = member;
	// With acts the figure stands ready: its act is in the label instead.
	const state = actLabel === undefined ? member.state : "ready";
	let role = "Bench";
	if (leading) {
		role = "Selected";
	} else if (inSquad) {
		role = "In squad";
	}
	const placed = inSquad ? role.toLowerCase() : "not in squad";
	const label =
		actLabel === undefined
			? `${agent.name}, ${SQUAD_STATE_DESCRIPTIONS[state]}, level ${level.level}, ${placed}.`
			: `${actLabel} Level ${level.level}, ${inSquad ? placed : "on the bench: more urgent agents are playing"}.`;
	return (
		<button
			aria-label={`${label} ${leading ? "Back to the lobby." : "Select and go to the lobby."}`}
			className={cn(
				"group/card relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) text-start shadow-[0_3px_0_var(--gk-edge)] outline-none transition-colors hover:bg-(--gk-plate-sunk) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			)}
			data-agent-id={agent.id}
			data-selected={leading || undefined}
			onClick={onPick}
			type="button"
		>
			<span
				className="relative flex h-40 items-end justify-center overflow-hidden pb-4"
				style={{ background: TILE_BACKDROP }}
			>
				<span className="relative h-[80%] transition-transform duration-200 ease-out group-hover/card:-translate-y-1 motion-reduce:transition-none">
					<span
						aria-hidden="true"
						className="absolute inset-x-[4%] -bottom-[3%] h-[8%]"
						style={FIGURE_SHADOW}
					/>
					<LobbyFigure
						agent={agent}
						className="relative h-full w-auto"
						state={state}
					/>
				</span>
				<span
					className={cn(
						KICKER,
						"absolute top-4 left-5 flex h-5 -skew-x-12 items-center px-2",
						leading
							? "bg-primary text-primary-foreground"
							: "bg-background/70 text-(--gk-ink)"
					)}
				>
					<span className="skew-x-12">{role}</span>
				</span>
				<span
					aria-hidden="true"
					className={cn(
						KICKER,
						"absolute top-4 right-7 flex h-5 items-center gap-1 text-(--gk-ink) opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-reduce:transition-none"
					)}
				>
					{leading ? "Back to lobby" : "Lead squad"}
					<ArrowRight className="size-3.5" />
				</span>
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-x-0 top-0 h-1",
					leading ? "bg-primary" : "bg-transparent"
				)}
			/>
			<span className="flex flex-1 flex-col gap-3 px-5 pt-4 pb-4">
				<span className="flex items-center justify-between gap-3">
					<span
						className={cn(
							DISPLAY,
							"truncate pt-0.5 text-(--gk-ink) text-[26px]"
						)}
					>
						{agent.name}
					</span>
					{actLabel === undefined ? <LobbyStateChip state={state} /> : null}
				</span>
				<span className="line-clamp-2 text-(--gk-ink-muted) text-[13px] leading-5">
					{agent.description || "No description"}
				</span>
				<dl className="mt-auto flex gap-6 border-(--gk-plate-sunk) border-t pt-3">
					<Stat label="Level" value={level.level} />
					<Stat label="Threads" value={member.threads.length} />
					<Stat label="Working" value={member.working} />
				</dl>
			</span>
		</button>
	);
}

/** SQUAD tab: every agent as a character card with their numbers. */
export function LobbyRoster({
	acts,
	loading,
	members,
	onPick,
	selectedId,
	squadIds,
}: {
	/** The act layer: each agent's act sentence and how many are working. */
	acts?: {
		labelOf: (agentId: string) => string | undefined;
		working: number;
	};
	loading: boolean;
	members: LobbyMember[];
	onPick: (agentId: string) => void;
	selectedId: string | undefined;
	squadIds: string[];
}) {
	const tl = useLiteralMessages();
	const working =
		acts?.working ??
		members.filter((member) => member.state === "in-match").length;
	const sorted = [...members].sort(
		(a, b) =>
			Number(squadIds.includes(b.agent.id)) -
				Number(squadIds.includes(a.agent.id)) ||
			squadIds.indexOf(a.agent.id) - squadIds.indexOf(b.agent.id) ||
			a.agent.name.localeCompare(b.agent.name)
	);
	return (
		<div className="@container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-8 max-sm:px-4 max-sm:py-4">
			<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<div className="flex flex-col gap-2">
					<h2
						className={cn(
							DISPLAY,
							"text-(--gk-ink) text-[40px] max-sm:text-[28px]"
						)}
					>
						Squad
					</h2>
					<p className="text-(--gk-ink-muted) text-[13px]">
						Pick an agent to lead your squad in the lobby.
					</p>
				</div>
				{loading ? null : (
					<p className={cn(KICKER, "text-(--gk-ink) tabular-nums")}>
						{tl(
							acts
								? "{count, plural, one {{countText} agent} other {{countText} agents}} · {working} working"
								: "{count, plural, one {{countText} agent} other {{countText} agents}} · {working} in match",
							{
								count: members.length,
								countText: String(members.length),
								working: String(working),
							}
						)}
					</p>
				)}
			</header>
			<ul
				aria-busy={loading}
				aria-label="Squad roster"
				className="grid @min-[1240px]:grid-cols-4 @min-[560px]:grid-cols-2 @min-[880px]:grid-cols-3 grid-cols-1 gap-4"
			>
				{loading
					? [0, 1, 2, 3].map((index) => (
							<li key={index}>
								<Skeleton className="h-[296px] w-full rounded-none" />
							</li>
						))
					: sorted.map((member) => (
							<li key={member.agent.id}>
								<RosterCard
									actLabel={acts?.labelOf(member.agent.id)}
									inSquad={squadIds.includes(member.agent.id)}
									leading={member.agent.id === selectedId}
									member={member}
									onPick={() => onPick(member.agent.id)}
								/>
							</li>
						))}
			</ul>
		</div>
	);
}
