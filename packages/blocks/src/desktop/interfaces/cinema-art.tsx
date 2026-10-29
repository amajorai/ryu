import { cn } from "@ryu/ui/lib/utils";
import { type CSSProperties, memo } from "react";
import type { CinemaArtSpec } from "./cinema-model.ts";
import {
	type CinemaFrame,
	cinemaField,
	cinemaMonogramFill,
	cinemaMonogramLine,
	cinemaShade,
	cinemaWallFill,
} from "./cinema-palette.ts";

/** The wall never runs past this many lines, or this many letters a line. */
const WALL_LINES = 4;
const WALL_LINE_LENGTH = 9;

/** Breaks a title into a few short, roughly even lines for the type wall. */
export function cinemaWallLines(text: string): string[] {
	const words = text.toUpperCase().split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	for (const word of words) {
		const last = lines.at(-1);
		if (
			last !== undefined &&
			last.length + word.length + 1 <= WALL_LINE_LENGTH
		) {
			lines[lines.length - 1] = `${last} ${word}`;
		} else {
			lines.push(word);
		}
	}
	return lines.slice(0, WALL_LINES);
}

/**
 * The billboard's art: the title set as a wall of heavy type, flush right
 * and cropped, alternating solid and outlined lines like a one-sheet.
 */
function TypeWall({ spec, text }: { spec: CinemaArtSpec; text: string }) {
	const lines = cinemaWallLines(text);
	const longest = Math.max(4, ...lines.map((line) => line.length));
	const fontSize = `min(${(88 / lines.length).toFixed(1)}cqh, ${(58 / (longest * 0.64)).toFixed(2)}cqw)`;
	return (
		<span
			className="absolute flex flex-col items-end font-black uppercase leading-[0.86] tracking-[-0.02em]"
			style={{ fontSize, right: "-1cqw", top: "6cqh" }}
		>
			{lines.map((line, index) => (
				<span
					className="block whitespace-nowrap bg-clip-text"
					key={`${index.toString()}-${line}`}
					style={
						index % 2 === 1
							? {
									color: "transparent",
									WebkitTextStroke: `2px ${cinemaMonogramLine(spec)}`,
								}
							: {
									backgroundImage: cinemaWallFill(spec),
									color: "transparent",
								}
					}
				>
					{line}
				</span>
			))}
		</span>
	);
}

/**
 * Where the monogram sits in each frame, in container units so it scales with
 * the art: cropped off the right edge of cards and the billboard, rising from
 * the foot of tall posters, always clear of where the title is set.
 */
const MONOGRAM: Record<CinemaFrame, CSSProperties> = {
	card: { fontSize: "150cqh", right: "-6cqw", top: "-22cqh" },
	hero: { bottom: "-30cqh", fontSize: "118cqh", right: "5cqw" },
	poster: { bottom: "-22cqh", fontSize: "125cqw", right: "-14cqw" },
};

/** Which edge each frame shades for its title. */
const SHADE: Record<CinemaFrame, "bottom" | "left" | "top"> = {
	card: "bottom",
	hero: "left",
	poster: "top",
};

/**
 * A title's key art: a lit field in the lead agent's colour and that agent's
 * monogram set huge and cropped, with a thin outline echo for depth. Every
 * title by one agent shares a colour and letter, so a row reads like a
 * franchise; the thread varies the lighting. Decorative: whatever sits on top
 * carries the title and status in text.
 */
export const CinemaArt = memo(function CinemaArt({
	className,
	frame = "card",
	spec,
	text,
}: {
	className?: string;
	frame?: CinemaFrame;
	spec: CinemaArtSpec;
	/** The billboard sets this text (the title) as its type wall. */
	text?: string;
}) {
	const wall = frame === "hero" && text ? text : null;
	// Cards set their title over the art, so their monogram stays in the back.
	const quiet = frame !== "hero";
	const letter = cn(
		"absolute select-none leading-[0.8]",
		spec.type === "serif"
			? "font-semibold font-serif italic"
			: "font-black tracking-tighter"
	);
	return (
		<span
			aria-hidden="true"
			className={cn("block size-full overflow-hidden", className)}
			style={{ background: cinemaField(spec, frame), containerType: "size" }}
		>
			{wall ? <TypeWall spec={spec} text={wall} /> : null}
			<span
				className={cn(letter, wall && "hidden")}
				style={{
					...MONOGRAM[frame],
					color: "transparent",
					translate: "-3.5% -3.5%",
					WebkitTextStroke: `${frame === "hero" ? "2px" : "1px"} ${cinemaMonogramLine(spec, quiet)}`,
				}}
			>
				{spec.monogram}
			</span>
			<span
				className={cn(letter, "bg-clip-text", wall && "hidden")}
				style={{
					...MONOGRAM[frame],
					backgroundImage: cinemaMonogramFill(spec, quiet),
					color: "transparent",
				}}
			>
				{spec.monogram}
			</span>
			<span
				className="absolute inset-0"
				style={{ background: cinemaShade(SHADE[frame]) }}
			/>
		</span>
	);
});
