import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";
import { NOTIFICATION_LAYOUT_STEPS } from "@/src/lib/notification-layout.ts";
import {
	TOOL_DETAIL_STEPS,
	type ToolDetailValue,
} from "@/src/lib/tool-detail-ladder.ts";

/**
 * The stepped Detail level control — the same `RangeSlider` the composer's
 * reasoning-effort picker uses (`EffortSliderRow`), so a level ladder reads the
 * same everywhere in the app: one detent per level, the active level named above
 * the track, every level captioned below it, painted with the shared cool → hot
 * fill ramp (`level-ramp.ts`). `LEVEL_RAMP_CLASS` on the wrapper is load-bearing:
 * it declares the variable the ramp's top stop resolves against, and without it
 * the whole `color-mix` is invalid and the fill silently vanishes.
 *
 * "Custom" is shown as the value label with the thumb parked on the nearest
 * level; the slider stays live, so moving it commits that level and clears the
 * custom state.
 */
export function ToolDetailSlider({
	preset,
	step,
	onStepChange,
}: {
	onStepChange: (next: number) => void;
	preset: ToolDetailValue;
	step: number;
}) {
	const activeLabel =
		preset === "custom"
			? "Custom"
			: (TOOL_DETAIL_STEPS.find((s) => s.id === preset)?.label ?? "");

	return (
		<div className={cn("flex w-[220px] flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
			<div className="flex items-center justify-end">
				<span className="truncate text-foreground text-xs" title={activeLabel}>
					{activeLabel}
				</span>
			</div>
			<RangeSlider
				aria-label="Detail level"
				className="h-8"
				fillColor={levelFillColor(step, TOOL_DETAIL_STEPS.length)}
				// Announce what the caption shows: a Custom mix parks the thumb on
				// the nearest level, but that level is not the user's setting.
				formatValueText={(v) =>
					preset === "custom"
						? activeLabel
						: (TOOL_DETAIL_STEPS[Math.round(v)]?.label ?? String(v))
				}
				max={TOOL_DETAIL_STEPS.length - 1}
				min={0}
				onValueChange={onStepChange}
				step={1}
				value={step}
			/>
			<div className="flex items-center justify-between gap-1">
				{TOOL_DETAIL_STEPS.map((s, i) => (
					<span
						className={cn(
							"flex-1 truncate text-xs leading-none",
							i === 0 && "text-left",
							i === TOOL_DETAIL_STEPS.length - 1 && "text-right",
							i > 0 && i < TOOL_DETAIL_STEPS.length - 1 && "text-center",
							preset !== "custom" && i === step
								? "text-foreground"
								: "text-muted-foreground/70"
						)}
						key={s.id}
						title={s.label}
					>
						{s.label}
					</span>
				))}
			</div>
		</div>
	);
}

export function NotificationLayoutSlider({
	onStepChange,
	step,
}: {
	onStepChange: (next: number) => void;
	step: number;
}) {
	const activeLabel = NOTIFICATION_LAYOUT_STEPS[step]?.label ?? "Unified";

	return (
		<div className={cn("flex w-[220px] flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
			<div className="flex items-center justify-end">
				<span className="truncate text-foreground text-xs" title={activeLabel}>
					{activeLabel}
				</span>
			</div>
			<RangeSlider
				aria-label="Notification layout"
				className="h-8"
				fillColor={levelFillColor(step, NOTIFICATION_LAYOUT_STEPS.length)}
				formatValueText={(value) =>
					NOTIFICATION_LAYOUT_STEPS[Math.round(value)]?.label ?? String(value)
				}
				max={NOTIFICATION_LAYOUT_STEPS.length - 1}
				min={0}
				onValueChange={onStepChange}
				step={1}
				value={step}
			/>
			<div className="flex items-center justify-between gap-1">
				{NOTIFICATION_LAYOUT_STEPS.map((layout, index) => (
					<span
						className={cn(
							"flex-1 truncate text-xs leading-none",
							index === 0 && "text-left",
							index === NOTIFICATION_LAYOUT_STEPS.length - 1 && "text-right",
							index > 0 &&
								index < NOTIFICATION_LAYOUT_STEPS.length - 1 &&
								"text-center",
							index === step ? "text-foreground" : "text-muted-foreground/70"
						)}
						key={layout.id}
						title={layout.label}
					>
						{layout.label}
					</span>
				))}
			</div>
		</div>
	);
}
