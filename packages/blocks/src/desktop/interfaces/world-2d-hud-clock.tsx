import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useState } from "react";
import { frameStyle, SV_TEXT } from "./world-2d-frame.ts";
import { HUD_FONT } from "./world-2d-hud-chrome.tsx";
import { SV_ICONS, SV_UI } from "./world-2d-palette.ts";

/** Current time, refreshed every 20 seconds. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 20_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

function SunIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M4 0h1v1h-1zM4 8h1v1h-1zM0 4h1v1h-1zM8 4h1v1h-1zM1 1h1v1h-1zM7 1h1v1h-1zM1 7h1v1h-1zM7 7h1v1h-1z"
				fill={SV_ICONS.sunRay}
			/>
			<path d="M3 2h3v1h1v3h-1v1h-3v-1h-1v-3h1z" fill={SV_ICONS.sun} />
			<path d="M3 3h1v1h-1z" fill={SV_ICONS.sunGlint} />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M3 0h3v1h-3zM2 1h2v1h-2zM1 2h3v5h-3zM2 7h2v1h-2zM3 8h3v1h-3z"
				fill={SV_ICONS.moon}
			/>
			<path d="M1 3h1v3h-1zM3 8h2v1h-2z" fill={SV_ICONS.moonShade} />
			<path d="M3 1h1v1h-1z" fill={SV_ICONS.moonGlint} />
		</svg>
	);
}

/** Spring leaf: the season badge. */
function LeafIcon() {
	return (
		<svg
			aria-hidden="true"
			height="18"
			shapeRendering="crispEdges"
			viewBox="0 0 9 9"
			width="18"
		>
			<path
				d="M5 1h3v3h-1v2h-1v1h-3v1h-2v-1h1v-1h1v-2h1v-2h1z"
				fill={SV_ICONS.leaf}
			/>
			<path
				d="M6 2h1v1h-1zM5 3h1v1h-1zM4 4h1v1h-1zM3 5h1v1h-1z"
				fill={SV_ICONS.leafVein}
			/>
		</svg>
	);
}

/**
 * Stardew's dial: a half disc from dawn (left) to dusk (right) with a hand
 * pointing at the real time of day. The sky follows the clock it sits
 * beside (not the world's theme): daylight blue with clouds and a sunset
 * edge by day, dark with a moon and stars at night.
 */
function DayDial({ hours, night }: { hours: number; night: boolean }) {
	// 6:00 points left, 2:00 (26h) points right.
	const progress = Math.min(1, Math.max(0, ((hours - 6 + 24) % 24) / 20));
	const angle = Math.PI * (1 - progress);
	const hx = Math.round(12 + Math.cos(angle) * 8);
	const hy = Math.round(12 - Math.sin(angle) * 8);
	return (
		<svg
			aria-hidden="true"
			height="39"
			shapeRendering="crispEdges"
			viewBox="0 0 24 13"
			width="72"
		>
			<path
				d="M7 1h10v1h2v1h1v1h1v2h1v2h1v5h-22v-5h1v-2h1v-2h1v-1h1v-1h2z"
				fill={SV_UI.outline}
			/>
			<path
				d="M7 2h5v10h-10v-4h1v-2h1v-2h1v-1h2z"
				fill={night ? SV_ICONS.dialNightDawn : SV_ICONS.dialDawn}
			/>
			<path
				d="M12 2h5v1h2v1h1v2h1v2h1v4h-10z"
				fill={night ? SV_ICONS.dialNightDusk : SV_ICONS.dialDusk}
			/>
			{night ? (
				<path
					d="M5 4h2v1h-1v2h1v1h-2v-1h-1v-2h1zM9 8h1v1h-1z"
					fill={SV_ICONS.star}
				/>
			) : (
				<path d="M4 9h3v1h-3zM8 7h2v1h-2z" fill={SV_ICONS.cloud} />
			)}
			<path
				d="M15 5h1v1h-1zM18 8h1v1h-1zM14 9h1v1h-1z"
				fill={night ? SV_ICONS.star : SV_ICONS.dialSparkle}
			/>
			<path d="M2 11h20v1h-20z" fill={SV_ICONS.dialHorizon} />
			<line
				stroke={SV_ICONS.dialHand}
				strokeWidth="1.4"
				x1="12"
				x2={hx}
				y1="12"
				y2={hy}
			/>
			<path d="M11 11h2v2h-2z" fill={SV_UI.outline} />
		</svg>
	);
}

/**
 * The time the way Stardew's clock shows it: "8:20 am", stepping in
 * ten-minute increments.
 */
export function stardewTime(date: Date): string {
	const hours = date.getHours();
	const minutes = Math.floor(date.getMinutes() / 10) * 10;
	const hour = hours % 12 === 0 ? 12 : hours % 12;
	return `${hour}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
}

/** The "!" quest marker as a small HUD glyph (gold, or red for trouble). */
export function QuestMark({
	size = 11,
	tone,
}: {
	size?: number;
	tone: "attention" | "your-turn";
}) {
	const attention = tone === "attention";
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height={size}
			shapeRendering="crispEdges"
			viewBox="0 0 5 11"
			width={Math.round((size * 5) / 11)}
		>
			<path
				d="M0 0h5v5h-1v2h-3v-2h-1zM0 8h5v3h-5z"
				fill={attention ? SV_UI.redDark : SV_UI.alertLine}
			/>
			<path
				d="M1 1h3v3h-1v2h-1v-2h-1zM1 9h3v1h-3z"
				fill={attention ? SV_UI.red : SV_UI.alert}
			/>
		</svg>
	);
}

/** Stardew's "..." for a busy villager: three static pixel dots. */
export function WorkingDots() {
	return (
		<span aria-hidden="true" className="inline-flex shrink-0 items-end gap-0.5">
			{[0, 1, 2].map((dot) => (
				<span className="size-1 bg-(--sv-ink)" key={dot} />
			))}
		</span>
	);
}

/** First and last hour (local, 24h) the clock box shows as daytime. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 19;

/**
 * Stardew's clock and date box, adapted to Ryu: the local weekday and day,
 * the dial and the real time, and below them how many villagers are
 * waiting on the user (the number that matters) and how many are working.
 * The dial and the sun or moon follow the printed time; only the village
 * art follows the app's theme.
 */
export function ClockBox({
	compact = false,
	needYouCount,
	showStatus = true,
	workingCount,
}: {
	/** Narrow viewports drop the dial so the box covers less of the world. */
	compact?: boolean;
	needYouCount: number;
	/** The villagers' tally under the clock (off while empty or loading). */
	showStatus?: boolean;
	workingCount: number;
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	const weekday = now.toLocaleDateString(undefined, { weekday: "short" });
	const time = stardewTime(now);
	const hours = now.getHours() + now.getMinutes() / 60;
	const night = hours < DAY_START_HOUR || hours >= DAY_END_HOUR;
	const date = (
		<time dateTime={now.toISOString().slice(0, 10)}>
			{weekday}. {now.getDate()}
		</time>
	);
	const clock = (
		<time className="tabular-nums" dateTime={now.toISOString()}>
			{time}
		</time>
	);
	return (
		<section
			aria-label="Village clock"
			className={cn("pointer-events-auto", HUD_FONT)}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			{compact ? (
				<p className="flex items-center gap-2 text-[16px] leading-none">
					{night ? <MoonIcon /> : <SunIcon />}
					{date}
					{clock}
				</p>
			) : (
				<div className="flex items-stretch">
					<div className="-my-1 -ml-1 flex items-end pr-1">
						<DayDial hours={hours} night={night} />
					</div>
					<div className="flex min-w-[92px] flex-col items-center justify-center gap-1 border-(--sv-slot-shade) border-l-2 pl-2 text-[16px] leading-none">
						<p>{date}</p>
						<p className="flex items-center gap-1">
							{night ? <MoonIcon /> : <SunIcon />}
							<LeafIcon />
						</p>
						<p>{clock}</p>
					</div>
				</div>
			)}
			{showStatus ? (
				<p className="mt-2 flex flex-col gap-1 border-(--sv-slot-shade) border-t-2 pt-2 text-[16px] leading-5">
					{needYouCount > 0 ? (
						<span className="inline-flex items-center gap-2">
							<span className="flex w-4 justify-center">
								<QuestMark size={11} tone="your-turn" />
							</span>
							{tl("{count} need you", { count: String(needYouCount) })}
						</span>
					) : (
						<span className="text-(--sv-ink-soft)">All caught up</span>
					)}
					<span className="inline-flex items-center gap-2">
						<span className="flex w-4 justify-center">
							<WorkingDots />
						</span>
						{tl("{count} working", { count: String(workingCount) })}
					</span>
				</p>
			) : null}
		</section>
	);
}
