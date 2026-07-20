// Wave — based on loading-ui.com (https://loading-ui.com/docs/components/wave).
//
// Two modes, both rendered as the same FIVE rounded `bg-current` bars with the
// loader's geometry, so live voice input looks like the original component:
//   - default (no `levels`): the five bars play the built-in `loading-ui-wave`
//     keyframe animation — a generic "listening / processing" indicator.
//   - live (`levels` provided): the five bars track the microphone loudness. Any
//     length of amplitude history (0..1) the caller passes is bucketed down to
//     exactly five bars; each bar is vertically centred so it grows up AND down
//     equally from the middle, matching the loader's symmetric shape. Silence
//     reads as a flat low line, speech makes the bars rise.
//
// Shared in `@ryu/ui` so both the desktop composer and the island companion
// render the same waveform for voice input.

import { cn } from "../lib/utils.ts";

const WAVE_BAR_HEIGHTS = ["50%", "75%", "100%", "75%", "50%"] as const;

/** The live waveform defaults to five bars to match the loader. */
const LIVE_BAR_COUNT = 5;

type WaveProps = React.ComponentProps<"span"> & {
	/**
	 * Live amplitude history in the range 0..1, oldest-to-newest. When provided,
	 * the component buckets it down to `barCount` bars and tracks loudness live
	 * instead of playing the looping loader animation.
	 */
	levels?: number[];
	/**
	 * Number of live bars to render. Omit for the loader's five-bar look (small
	 * inline indicator). Pass a larger count for a wide, full-width waveform (e.g.
	 * the composer's recording state): the bars then flex to fill the container,
	 * so any count spans the full width instead of the fixed narrow inline layout.
	 */
	barCount?: number;
};

/** Minimum visible bar height so a silent mic still shows a flat line, not nothing. */
const MIN_LEVEL = 0.08;

/**
 * Reduce an arbitrary-length amplitude array to exactly `count` bar heights by
 * averaging contiguous buckets, so the live waveform always renders `count` bars
 * no matter how many samples the caller provides.
 */
function toBars(levels: number[], count: number): number[] {
	const bars = new Array<number>(count).fill(0);
	if (levels.length === 0) {
		return bars;
	}
	for (let i = 0; i < count; i++) {
		const start = Math.floor((i * levels.length) / count);
		const end = Math.max(
			start + 1,
			Math.floor(((i + 1) * levels.length) / count)
		);
		let sum = 0;
		let n = 0;
		for (let j = start; j < end && j < levels.length; j++) {
			sum += levels[j] ?? 0;
			n++;
		}
		bars[i] = n > 0 ? sum / n : 0;
	}
	return bars;
}

function LiveWave({
	className,
	levels,
	barCount,
	...props
}: WaveProps & { levels: number[] }) {
	// A custom `barCount` means the wide, full-width layout: the bars flex to
	// share the container width so any count spans it. The default (no barCount)
	// keeps the loader's five fixed-width inline bars for the small indicator.
	const fill = barCount != null;
	const count = barCount ?? LIVE_BAR_COUNT;
	return (
		<span
			className={cn(
				"inline-flex items-center",
				fill ? "gap-0.5" : "gap-[2.5%]",
				className
			)}
			role="status"
			{...props}
		>
			{toBars(levels, count).map((level, index) => (
				<span
					aria-hidden="true"
					className={cn(
						"inline-block rounded-full bg-current",
						fill && "flex-1"
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed bar layout
					key={index}
					style={{
						// `items-center` centres each bar, so it grows up AND down equally.
						width: fill ? undefined : "12.5%",
						height: `${Math.round(Math.max(MIN_LEVEL, Math.min(1, level)) * 100)}%`,
						transition: "height 90ms linear",
					}}
				/>
			))}
			<span className="sr-only">Recording</span>
		</span>
	);
}

function Wave({ className, levels, barCount, ...props }: WaveProps) {
	if (Array.isArray(levels)) {
		return (
			<LiveWave
				barCount={barCount}
				className={className}
				levels={levels}
				{...props}
			/>
		);
	}
	return (
		<>
			<style>{`
        @keyframes loading-ui-wave {
          0%,
          100% {
            transform: scaleY(1);
          }

          50% {
            transform: scaleY(0.6);
          }
        }
      `}</style>
			<span
				className={cn("inline-flex items-center gap-[2.5%]", className)}
				role="status"
				{...props}
			>
				{WAVE_BAR_HEIGHTS.map((height, index) => (
					<span
						aria-hidden="true"
						className="inline-block rounded-full bg-current"
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed 5-bar layout
						key={index}
						style={{
							width: "12.5%",
							height,
							animation:
								"loading-ui-wave var(--duration, 1s) ease-in-out infinite",
							animationDelay: `calc(var(--delay, 100ms) * ${index})`,
						}}
					/>
				))}
				<span className="sr-only">Loading</span>
			</span>
		</>
	);
}

export { Wave };
