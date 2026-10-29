import { cn } from "@ryu/ui/lib/utils";

/*
 * Unit milestones, drawn flat in the theme's warning role (gold in every
 * stock theme) with warning-foreground shading, so they sit beside the path's
 * stops without a fixed palette. An open unit shows a closed chest; a finished
 * unit shows a trophy. Art nobody has made progress toward yet is drawn
 * locked: desaturated and faded, like the reference's unreached milestones.
 * Both are decorative: the caption beside them says it.
 */

const LOCKED = "opacity-45 grayscale";

const SHADE = "fill-warning-foreground/20";

export function PathChest({
	className,
	progress = 1,
}: {
	className?: string;
	/** Share of the unit finished, 0 to 1; at 0 the chest is drawn locked. */
	progress?: number;
}) {
	return (
		<svg
			aria-hidden="true"
			className={cn("h-14 w-16", progress <= 0 && LOCKED, className)}
			viewBox="0 0 64 56"
		>
			<path
				className="fill-warning"
				d="M6 22V17C6 10.92 10.92 6 17 6H47C53.08 6 58 10.92 58 17V22Z"
			/>
			<rect
				className="fill-warning"
				height="26"
				rx="5"
				width="52"
				x="6"
				y="24"
			/>
			<rect className={SHADE} height="6" rx="3" width="52" x="6" y="44" />
			<rect className={SHADE} height="44" width="5" x="15" y="6" />
			<rect className={SHADE} height="44" width="5" x="44" y="6" />
			<rect
				className="fill-warning-foreground/35"
				height="3"
				width="52"
				x="6"
				y="22"
			/>
			<rect
				className="fill-warning-foreground/70"
				height="13"
				rx="3"
				width="10"
				x="27"
				y="18"
			/>
			<circle className="fill-warning" cx="32" cy="25" r="2" />
		</svg>
	);
}

export function PathTrophy({
	className,
	locked = false,
}: {
	className?: string;
	locked?: boolean;
}) {
	return (
		<svg
			aria-hidden="true"
			className={cn("h-16 w-16", locked && LOCKED, className)}
			viewBox="0 0 64 64"
		>
			<path
				className="fill-none stroke-warning"
				d="M18 14H11.5C11.5 22 14 26 19 27M46 14H52.5C52.5 22 50 26 45 27"
				strokeLinecap="round"
				strokeWidth="5"
			/>
			<path
				className="fill-warning"
				d="M16 8H48V24C48 32.84 40.84 40 32 40C23.16 40 16 32.84 16 24Z"
			/>
			<path
				className={SHADE}
				d="M40 8H48V24C48 30.5 44.1 36.1 38.5 38.6C39.5 34 40 29 40 24Z"
			/>
			<rect className="fill-warning" height="9" width="8" x="28" y="39" />
			<rect
				className="fill-warning"
				height="10"
				rx="3"
				width="28"
				x="18"
				y="47"
			/>
			<rect className={SHADE} height="4" rx="2" width="28" x="18" y="53" />
		</svg>
	);
}
