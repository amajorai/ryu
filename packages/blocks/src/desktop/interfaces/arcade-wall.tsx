import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import { type ArcadePalette, bulbGlow } from "./arcade-palette.ts";

/**
 * The back wall: one marquee, centred, naming the floor ("Arcade", or the
 * project or team it is narrowed to), framed in chasing bulbs, over the
 * wall's neon rail. Everything else the wall used to hold (the change
 * machine, the prize counter, the team cabinets, the side lettering) lives
 * in the HUD, so the floor has a single sign instead of several competing.
 */

/** The wall's height: the marquee sits under the HUD's top row when narrow. */
export function wallHeight(hudWidth: number): number {
	if (hudWidth < 640) {
		return 172;
	}
	return hudWidth < 1100 ? 224 : 156;
}

const BULBS_PER_ROW = 18;

function Bulbs({
	palette,
	reduced,
	row,
}: {
	palette: ArcadePalette;
	reduced: boolean;
	row: "bottom" | "top";
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute inset-x-4 flex justify-between",
				row === "top" ? "top-2" : "bottom-2"
			)}
		>
			{Array.from({ length: BULBS_PER_ROW }, (_, index) => {
				const style: CSSProperties = reduced
					? {}
					: {
							animationDelay: `${((index + (row === "top" ? 0 : 1)) % 3) * 0.3}s`,
							animationDuration: "0.9s",
							animationIterationCount: "infinite",
							animationName: "arcade-chase",
							animationTimingFunction: "steps(1, end)",
						};
				return (
					<span
						className="size-2 rounded-full"
						// Bulb positions are fixed per row: index is the identity.
						key={`${row}-${index.toString()}`}
						style={{
							...style,
							background: palette.coin,
							boxShadow: `0 0 0 1px ${palette.coinEdge}${palette.mode === "dark" ? `, 0 0 6px 1px ${palette.coin}` : ""}`,
						}}
					/>
				);
			})}
		</span>
	);
}

export function ArcadeWall({
	hudWidth,
	palette,
	reduced,
	title,
	titleAs: Title = "h1",
}: {
	hudWidth: number;
	palette: ArcadePalette;
	reduced: boolean;
	/** "p" when the game already has its page heading (the act layer's). */
	titleAs?: "h1" | "p";
	/** The floor's name: the arcade, or the project or team it shows. */
	title: string;
}) {
	const night = palette.mode === "dark";
	const narrow = hudWidth < 640;
	return (
		<section
			aria-label="Marquee"
			className="relative flex shrink-0 flex-col overflow-hidden"
			style={{ background: palette.wall, height: wallHeight(hudWidth) }}
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0"
				style={{ background: `${palette.wallLight}, ${palette.wallSeams}` }}
			/>
			<div className="relative flex flex-1 items-end justify-center px-4 pb-4">
				<div
					className={cn(
						"relative flex w-full items-center justify-center rounded-[18px] px-10",
						narrow ? "h-[76px] max-w-[340px]" : "h-[104px] max-w-[600px]"
					)}
					style={{
						background: palette.ledBackground,
						boxShadow: `inset 0 0 0 3px ${palette.neon}, 0 0 0 4px ${palette.wallBase}, 0 14px 28px -12px ${palette.floorShadow}`,
					}}
				>
					<Bulbs palette={palette} reduced={reduced} row="top" />
					<Title
						className={cn(
							// Room around the letters so their glow is never clipped.
							"gk-display truncate px-4 py-3 text-center uppercase leading-none tracking-[0.14em]",
							narrow ? "text-[30px]" : "text-[48px]"
						)}
						// The sign is lit from inside in both moods: neon tube colour
						// at night, warm marquee lamps by day.
						style={{
							color: night ? palette.wallSign : palette.ledLit,
							textShadow: `0 0 14px ${night ? palette.wallSign : palette.ledLit}`,
						}}
					>
						{title}
					</Title>
					<Bulbs palette={palette} reduced={reduced} row="bottom" />
				</div>
			</div>
			<div
				aria-hidden="true"
				className="relative h-1 shrink-0"
				style={{
					background: palette.neon,
					boxShadow: bulbGlow(palette.mode, palette.neon),
				}}
			/>
			<div
				aria-hidden="true"
				className="h-3 shrink-0"
				style={{ background: palette.wallBase }}
			/>
		</section>
	);
}
