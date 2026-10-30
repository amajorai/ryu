import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useContext } from "react";
import { TownActMode } from "./town-desk-act-mode.ts";
import { districtSwatch } from "./town-desk-minimap.tsx";
import type { Town } from "./town-model.ts";
import type { TownDataView, TownPalette } from "./town-palette.ts";

const DISTRICT_COLUMNS = "grid grid-cols-[1fr_3.5rem_3rem] items-center gap-2";

/** The districts as a list: the accessible twin of the minimap. */
export function DistrictList({
	dataView,
	highlightId,
	onDistrict,
	onHighlight,
	palette,
	town,
}: {
	dataView: TownDataView;
	highlightId: string | null;
	onDistrict: (districtId: string) => void;
	onHighlight: (id: string | null) => void;
	palette: TownPalette;
	town: Town;
}) {
	const tl = useLiteralMessages();
	const actMode = useContext(TownActMode);
	return (
		<div className="flex flex-col">
			<div
				aria-hidden="true"
				className={cn(
					DISTRICT_COLUMNS,
					"h-6 px-2 text-(--gk-ink-muted) text-[13px]"
				)}
			>
				<span>District</span>
				<span className="text-right">Waiting</span>
				<span className="text-right">Total</span>
			</div>
			<ul
				aria-label="Districts"
				className="flex flex-col"
				onPointerLeave={() => onHighlight(null)}
			>
				{town.districts.map((district) => (
					<li key={district.id}>
						<button
							aria-label={
								actMode
									? tl(
											"{name}: {buildings, plural, one {{buildingCount} building} other {{buildingCount} buildings}}, {petitionCount} waiting on you, {threads, plural, one {{threadCount} conversation} other {{threadCount} conversations}} in all. Show on the map",
											{
												buildingCount: String(district.buildings.length),
												buildings: district.buildings.length,
												name: district.name,
												petitionCount: String(district.petitions),
												threadCount: String(district.threads.length),
												threads: district.threads.length,
											}
										)
									: tl(
											"{name}: {buildings, plural, one {{buildingCount} building} other {{buildingCount} buildings}}, {threads, plural, one {{threadCount} conversation} other {{threadCount} conversations}}, {petitions, plural, one {{petitionCount} petition} other {{petitionCount} petitions}}. Show on the map",
											{
												buildingCount: String(district.buildings.length),
												buildings: district.buildings.length,
												name: district.name,
												petitionCount: String(district.petitions),
												petitions: district.petitions,
												threadCount: String(district.threads.length),
												threads: district.threads.length,
											}
										)
							}
							className={cn(
								DISTRICT_COLUMNS,
								"h-8 w-full rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-(--gk-plate-sunk) focus-visible:ring-(--gk-focus) focus-visible:ring-3 focus-visible:ring-inset",
								highlightId === district.id && "bg-(--gk-plate-sunk)"
							)}
							onBlur={() => onHighlight(null)}
							onClick={() => onDistrict(district.id)}
							onFocus={() => onHighlight(district.id)}
							onPointerEnter={() => onHighlight(district.id)}
							type="button"
						>
							<span className="flex min-w-0 items-center gap-2">
								<span
									aria-hidden="true"
									className="size-2.5 shrink-0 rounded-sm ring-1 ring-foreground/25"
									style={{
										backgroundColor: districtSwatch(
											palette,
											dataView,
											district
										),
									}}
								/>
								<span className="truncate text-(--gk-ink)">
									{district.name}
								</span>
							</span>
							<span
								className={cn(
									"text-right text-[13px] tabular-nums",
									district.petitions > 0
										? "font-medium text-(--gk-ink)"
										: "text-(--gk-ink-muted)"
								)}
							>
								{district.petitions}
							</span>
							<span className="text-right text-(--gk-ink-muted) text-[13px] tabular-nums">
								{district.threads.length}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
