import { Button } from "@ryu/ui/components/button.tsx";
import { Plus } from "lucide-react";
import { marqueeBulbs, marqueePath } from "./arcade-model.ts";
import type { ArcadePalette } from "./arcade-palette.ts";
import { ReelGlyph } from "./arcade-reels.tsx";

/**
 * The empty floor: one unlit slot machine under a spotlight, its marquee
 * reading OPENING SOON, with the explanation and the one action set on the
 * carpet beneath it. Same drawing language as the live cabinets (marquee
 * outline, bulb ring, smoked reels), with the power off.
 */

const WIDTH = 168;
const MARQUEE = 52;
const REELS = ["left", "centre", "right"] as const;

function UnlitMachine({
	label,
	palette,
}: {
	label: string;
	palette: ArcadePalette;
}) {
	const { ghost } = palette;
	const bulbs = marqueeBulbs("arch", WIDTH, MARQUEE, 22, 5);
	return (
		<div aria-hidden="true" className="flex flex-col" style={{ width: WIDTH }}>
			<div className="relative" style={{ height: MARQUEE, width: WIDTH }}>
				<svg
					className="absolute inset-0"
					height={MARQUEE}
					viewBox={`0 0 ${WIDTH} ${MARQUEE}`}
					width={WIDTH}
				>
					<path
						d={marqueePath("arch", WIDTH, MARQUEE)}
						fill={ghost.sign}
						stroke={ghost.shade}
						strokeWidth={3}
					/>
					{bulbs.map((bulb) => (
						<circle
							cx={bulb.x}
							cy={bulb.y}
							fill={palette.bulbOff}
							key={`${bulb.x}-${bulb.y}`}
							r={2.2}
						/>
					))}
				</svg>
				<span
					className="absolute inset-x-4 bottom-2.5 flex h-6 items-center justify-center font-bold font-mono text-[12px] leading-none tracking-[0.2em]"
					style={{ color: palette.ledLabel }}
				>
					{label}
				</span>
			</div>
			<div
				className="flex flex-col gap-2 p-3"
				style={{
					background: ghost.body,
					borderLeft: `6px solid ${ghost.shade}`,
					borderRight: `6px solid ${ghost.shade}`,
				}}
			>
				<div
					className="flex justify-between rounded-[6px] p-1.5"
					style={{ background: ghost.shade }}
				>
					{REELS.map((reel) => (
						<span
							className="relative flex h-12 w-10 items-center justify-center overflow-hidden rounded-[3px]"
							key={reel}
							style={{ background: palette.reelFace }}
						>
							<span className="opacity-60">
								<ReelGlyph palette={palette} size={28} symbol="blank" />
							</span>
							<span
								className="absolute inset-0"
								style={{ background: palette.reelCover }}
							/>
						</span>
					))}
				</div>
				<span
					className="h-5 rounded-[4px]"
					style={{ background: ghost.screen }}
				/>
				<span
					className="h-10 rounded-[6px]"
					style={{ background: ghost.screen }}
				/>
			</div>
			<span
				className="h-2.5 rounded-b-[4px]"
				style={{ background: ghost.shade }}
			/>
		</div>
	);
}

export function ArcadeEmpty({
	action,
	body,
	marquee,
	onAction,
	palette,
	title,
}: {
	action: string;
	body: string;
	/** What the unlit marquee reads. */
	marquee: string;
	onAction: () => void;
	palette: ArcadePalette;
	title: string;
}) {
	return (
		<section
			aria-label={title}
			className="relative flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12"
			data-arcade-empty=""
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-1/2 h-[560px] w-[min(720px,100%)] -translate-x-1/2 -translate-y-1/2"
				style={{ background: palette.spotlight }}
			/>
			<div className="relative">
				<UnlitMachine label={marquee} palette={palette} />
			</div>
			<div className="relative flex max-w-sm flex-col items-center gap-4 text-center">
				<div className="flex flex-col gap-1.5">
					<h2 className="text-balance font-heading font-semibold text-base text-foreground leading-6">
						{title}
					</h2>
					<p className="text-pretty text-foreground/75 text-sm leading-5">
						{body}
					</p>
				</div>
				<Button onClick={onAction} size="sm" type="button">
					<Plus aria-hidden="true" data-icon="inline-start" />
					{action}
				</Button>
			</div>
		</section>
	);
}
