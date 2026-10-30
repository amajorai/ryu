"use client";

// The composer picker's reasoning-effort control: one stepped detent per level
// the ACTIVE source advertises, not a fixed low→xhigh ladder.
//
// Two sources feed it and neither is hardcoded here:
//   - a Pi PROVIDER row  — `catalog.thinkingLevels` (use-universal-picker.ts),
//   - an external ACP AGENT — its own `select` config option, classified by
//     `isReasoningOption` in packages/blocks/src/composer/composer-acp-sections.ts.
//
// Both arrive as a `ComposerSettingsSection` whose `items` are already in the
// advertised order, so "autodetect" is just: render the live list. An agent with
// three levels gets three detents; Pi's `off · low · medium · high · max` gets
// five. Nothing renders at all when the source advertises nothing, and the
// reasoning-off capability override drops the section upstream, so a suppressed
// picker never leaves a dead track behind.
//
// The fill colour follows the same live list: it ramps green → orange → red →
// purple across whatever levels the source advertises, so the top detent is
// always the top of the ramp regardless of how many there are. That ramp lives
// in `@/src/lib/level-ramp.ts` because every stepped level slider in the app
// (Detail level, Interface level) paints with it — and because its top stop is a
// CSS variable the use site must declare (`LEVEL_RAMP_CLASS`), which is only
// safe to copy around if the class and the function ship together.

import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";

/** Above this many levels the per-detent captions stop fitting the popover. */
const MAX_CAPTIONED_LEVELS = 5;

export function EffortSliderRow({
	section,
	onSelect,
}: {
	/** Called with the picked item id (the section's own `onChange` wrapper). */
	onSelect: (id: string) => void;
	section: ComposerSettingsSection;
}) {
	const { items } = section;
	const activeIndex = Math.max(
		0,
		items.findIndex((it) => it.id === section.value)
	);
	const active = items[activeIndex];

	const handleChange = useCallback(
		(next: number) => {
			const picked = items[Math.round(next)];
			if (picked && picked.id !== section.value) {
				onSelect(picked.id);
			}
		},
		[items, onSelect, section.value]
	);

	if (items.length < 2) {
		return null;
	}

	const showCaptions = items.length <= MAX_CAPTIONED_LEVELS;

	return (
		// The menu owns arrow keys for row navigation, so the slider's own
		// Arrow/Home/End handling has to stop here or a nudge would move the
		// highlight instead of the value.
		<div
			className={cn("flex flex-col gap-1.5 px-2 py-1.5", LEVEL_RAMP_CLASS)}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-(length:--text-detail) text-muted-foreground">
					{section.label}
				</span>
				<span className="text-(length:--text-detail) max-w-[140px] truncate text-foreground">
					{active?.name}
				</span>
			</div>
			<RangeSlider
				aria-label={section.ariaLabel}
				className="h-8"
				fillColor={levelFillColor(activeIndex, items.length)}
				formatValueText={(v) => items[Math.round(v)]?.name ?? String(v)}
				max={items.length - 1}
				min={0}
				onValueChange={handleChange}
				step={1}
				value={activeIndex}
			/>
			{showCaptions && (
				<div className="flex items-center justify-between gap-1">
					{items.map((item, i) => (
						<span
							className={cn(
								"flex-1 truncate text-xs leading-none",
								i === 0 && "text-left",
								i === items.length - 1 && "text-right",
								i > 0 && i < items.length - 1 && "text-center",
								i === activeIndex
									? "text-foreground"
									: "text-muted-foreground/70"
							)}
							key={item.id}
						>
							{item.name}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
