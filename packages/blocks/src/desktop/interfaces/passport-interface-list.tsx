import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Stamp } from "lucide-react";
import { type ReactNode, useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { NO_VISAS_WAITING } from "./passport-acts.tsx";
import {
	countryLabel,
	type DeskLayout,
	stationLabel,
} from "./passport-desk.tsx";
import { UNASSIGNED_LABEL } from "./passport-model.ts";

export function LoadingIsles() {
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

/** The countries as a plain list, for stages without WebGL (and tests). */
export function PassportList({
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
	const tl = useLiteralMessages();
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
								aria-label={tl("{name}: apply for a visa", {
									name: station.country.agent.name,
								})}
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
