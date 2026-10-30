import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { MouseEvent, ReactNode } from "react";
import { GAME_FOCUS } from "./game-hud.tsx";
import { type PlanetSystem, plural } from "./planets-model.ts";

/**
 * How the planet list folds. Without acts: hidden under 1100px unless
 * opened (or always while folded in a sheet or beside a thread). With
 * acts the folded list is only visually hidden, so every row stays a
 * reachable target.
 */
export function listFold(
	acts: boolean,
	expanded: boolean,
	foldable: boolean
): string | null {
	if (expanded) {
		return null;
	}
	if (foldable) {
		return acts ? "sr-only" : "hidden";
	}
	return acts ? "@max-[1100px]:sr-only" : "@max-[1100px]:hidden";
}

/**
 * "1 needs you · 2 your turn · ": each count in its own status color, so one
 * failed run does not paint the whole line red; nothing when none wait.
 */
export function NeedsYou({
	attention,
	trailing = true,
	yourTurn,
}: {
	attention: number;
	/** Add the separator before whatever follows on the line. */
	trailing?: boolean;
	yourTurn: number;
}) {
	const tl = useLiteralMessages();
	const parts: ReactNode[] = [];
	if (attention > 0) {
		parts.push(
			<span className="font-medium text-status-destructive" key="attention">
				{tl("{attention} needs you", { attention })}
			</span>
		);
	}
	if (yourTurn > 0) {
		parts.push(
			<span className="font-medium text-(--planets-turn)" key="turn">
				{tl("{yourTurn} your turn", { yourTurn })}
			</span>
		);
	}
	if (parts.length === 0) {
		return null;
	}
	return (
		<>
			{parts[0]}
			{parts.length > 1 ? <> · {parts[1]}</> : null}
			{trailing ? " · " : null}
		</>
	);
}

/** The star's line when nothing waits on you. */
export function starMeta(system: PlanetSystem): string {
	return system.unassigned.length > 0
		? plural(system.unassigned.length, "own thread")
		: "Your star";
}

export function HudStat({
	label,
	loading,
	tone,
	value,
}: {
	label: string;
	loading: boolean;
	tone?: string;
	value: number;
}) {
	return (
		<div className="flex min-w-0 flex-col-reverse justify-end gap-0.5 not-first:border-(--gk-plate-sunk) not-first:border-l-2 py-2 pr-4 pl-3.5 last:pr-3.5">
			<dt className="truncate font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide">
				{label}
			</dt>
			<dd
				className={cn(
					"gk-display text-(--gk-ink) text-[26px] tabular-nums leading-7",
					tone
				)}
			>
				{loading ? <Skeleton className="my-1 h-4 w-6" radius="pill" /> : value}
			</dd>
		</div>
	);
}

export function BodyButton({
	act = null,
	active,
	description,
	meta,
	name,
	onBlur,
	onClick,
	onFocus,
	ref,
	swatch,
	tabbable,
	team,
	trailing,
}: {
	/** With acts: the row is this agent's target; an asking one answers. */
	act?: { agentId: string; asking: boolean } | null;
	active: boolean;
	description: string;
	meta: ReactNode;
	name: string;
	onBlur: () => void;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
	onFocus: () => void;
	ref: (element: HTMLButtonElement | null) => void;
	swatch: ReactNode;
	tabbable: boolean;
	team?: ReactNode;
	trailing: ReactNode;
}) {
	return (
		<button
			aria-current={active && !act?.asking ? "true" : undefined}
			aria-label={description}
			className={cn(
				"group flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-(--gk-plate-sunk) active:bg-(--gk-plate-sunk) aria-[current=true]:bg-(--gk-plate-sunk)",
				GAME_FOCUS
			)}
			data-act-agent={act?.agentId}
			onBlur={onBlur}
			onClick={onClick}
			onFocus={onFocus}
			onPointerEnter={onFocus}
			onPointerLeave={onBlur}
			ref={ref}
			tabIndex={tabbable ? 0 : -1}
			type="button"
		>
			{swatch}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="gk-display truncate text-(--gk-ink) text-[16px] leading-5">
						{name}
					</span>
					{team}
				</span>
				<span className="truncate text-[12px] text-muted-foreground leading-4">
					{meta}
				</span>
			</span>
			{trailing}
		</button>
	);
}
