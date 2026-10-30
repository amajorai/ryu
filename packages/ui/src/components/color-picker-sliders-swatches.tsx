"use client";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ComponentProps, useCallback, useMemo } from "react";
import styles from "./color-picker.module.css";
import {
	collectColorSwatches,
	colorToString,
	roundAlpha,
	serializeColor,
} from "./color-picker-color-format.ts";
import { hsvToRgb, rgbToHsv } from "./color-picker-color-math.ts";
import {
	ALPHA_SLIDER_NAME,
	type ColorPickerPaintStyle,
	type ColorValue,
	type DivProps,
	type HSVColorValue,
	HUE_SLIDER_NAME,
	SWATCH_NAME,
	useSlotRender,
} from "./color-picker-shared.ts";
import {
	MAX_RECENT_COLORS,
	recordRecentColor,
	useColorPickerContext,
	useRecentColors,
	useStore,
	useStoreContext,
} from "./color-picker-store.ts";

function ColorPickerHueSlider(
	props: ComponentProps<typeof SliderPrimitive.Root>
) {
	const { className, ...sliderProps } = props;

	const context = useColorPickerContext(HUE_SLIDER_NAME);
	const store = useStoreContext(HUE_SLIDER_NAME);

	const hsv = useStore((state) => state.hsv);

	const onValueChange = useCallback(
		(value: number | readonly number[]) => {
			const [nextHue] = [value].flat();
			const newHsv: HSVColorValue = {
				h: nextHue ?? 0,
				s: hsv?.s ?? 0,
				v: hsv?.v ?? 0,
				a: hsv?.a ?? 1,
			};
			store.setColorAndHsv(hsvToRgb(newHsv), newHsv);
		},
		[hsv, store]
	);

	return (
		<SliderPrimitive.Root
			data-slot="color-picker-hue-slider"
			{...sliderProps}
			disabled={context.disabled || context.readOnly}
			max={360}
			min={0}
			onValueChange={onValueChange}
			step={1}
			value={[hsv?.h ?? 0]}
		>
			<SliderPrimitive.Control
				className={cn(
					"relative flex w-full touch-none select-none items-center",
					className
				)}
			>
				<SliderPrimitive.Track className="relative h-3 w-full grow overflow-hidden rounded-full bg-[linear-gradient(to_right,#ff0000_0%,#ffff00_16.66%,#00ff00_33.33%,#00ffff_50%,#0000ff_66.66%,#ff00ff_83.33%,#ff0000_100%)]">
					<SliderPrimitive.Indicator className="absolute h-full" />
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb className="block size-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	);
}

function ColorPickerAlphaSlider(
	props: ComponentProps<typeof SliderPrimitive.Root>
) {
	const { className, ...sliderProps } = props;

	const context = useColorPickerContext(ALPHA_SLIDER_NAME);
	const store = useStoreContext(ALPHA_SLIDER_NAME);

	const color = useStore((state) => state.color);
	const hsv = useStore((state) => state.hsv);

	const onValueChange = useCallback(
		(value: number | readonly number[]) => {
			const [raw] = [value].flat();
			const alpha = (raw ?? 0) / 100;
			const newColor = { ...color, a: alpha };
			const newHsv = { ...hsv, a: alpha };
			store.setColorAndHsv(newColor, newHsv);
		},
		[color, hsv, store]
	);

	const alphaStyle: ColorPickerPaintStyle = {
		"--color-picker-alpha-r": color?.r ?? 0,
		"--color-picker-alpha-g": color?.g ?? 0,
		"--color-picker-alpha-b": color?.b ?? 0,
	};

	return (
		<SliderPrimitive.Root
			data-slot="color-picker-alpha-slider"
			{...sliderProps}
			disabled={context.disabled || context.readOnly}
			max={100}
			min={0}
			onValueChange={onValueChange}
			step={1}
			value={[Math.round((color?.a ?? 1) * 100)]}
		>
			<SliderPrimitive.Control
				className={cn(
					"relative flex w-full touch-none select-none items-center",
					className
				)}
			>
				<SliderPrimitive.Track
					className={cn(
						"relative h-3 w-full grow overflow-hidden rounded-full",
						styles.alphaChecker
					)}
				>
					<div
						className={cn("absolute inset-0 rounded-full", styles.alphaColor)}
						style={alphaStyle}
					/>
					<SliderPrimitive.Indicator className="absolute h-full" />
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb className="block size-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	);
}

function ColorPickerSwatch(props: DivProps) {
	const { asChild, className, ...swatchProps } = props;

	const tl = useLiteralMessages();
	const context = useColorPickerContext(SWATCH_NAME);

	const color = useStore((state) => state.color);
	const format = useStore((state) => state.format);

	const backgroundPaint = useMemo(() => {
		if (!color) {
			return { className: styles.emptyPaint, value: "" };
		}
		const colorString = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
		if (!hasFiniteColor(color)) {
			return { className: "", value: colorString };
		}
		return color.a < 1
			? {
					className: styles.translucentPaint,
					value: `linear-gradient(${colorString}, ${colorString}), repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0% 50% / 8px 8px`,
				}
			: { className: styles.opaquePaint, value: colorString };
	}, [color]);

	const paintStyle: ColorPickerPaintStyle = {
		"--color-picker-paint": backgroundPaint.value,
	};
	const ariaLabel = color
		? tl("Current color: {color}", {
				color: colorToString(color, format),
			})
		: "No color selected";

	return useSlotRender(asChild, {
		...swatchProps,
		"aria-label": ariaLabel,
		"data-slot": "color-picker-swatch",
		role: "img",
		className: cn(
			"corner-squircle box-border size-8 rounded-sm border shadow-sm",
			styles.forcedColorsNone,
			backgroundPaint.className,
			context.disabled && "opacity-50",
			className
		),
		style: paintStyle,
	});
}

function hasFiniteColor(color: ColorValue): boolean {
	return [color.r, color.g, color.b, color.a].every(Number.isFinite);
}

function colorSwatchPaint(color: ColorValue): string {
	const colorString = `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${roundAlpha(color.a)})`;
	return color.a < 1
		? `linear-gradient(${colorString}, ${colorString}), repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0% 50% / 8px 8px`
		: colorString;
}

function colorSwatchPaintClass(color: ColorValue): string {
	return hasFiniteColor(color)
		? color.a < 1
			? styles.translucentPaint
			: styles.opaquePaint
		: "";
}

interface ColorPickerSwatchesProps extends ComponentProps<"div"> {
	colors?: string[];
	recentColors?: string[];
}

function ColorPickerSwatches({
	className,
	colors: colorsProp,
	recentColors: recentColorsProp,
	...props
}: ColorPickerSwatchesProps) {
	const tl = useLiteralMessages();
	const context = useColorPickerContext(SWATCH_NAME);
	const store = useStoreContext(SWATCH_NAME);
	const currentColor = useStore((state) => state.color);
	const storedRecentColors = useRecentColors();
	const recentColors = recentColorsProp ?? storedRecentColors;
	const swatches = colorsProp ?? context.swatches;

	const parsedRecentColors = useMemo(
		() => collectColorSwatches(recentColors, MAX_RECENT_COLORS),
		[recentColors]
	);
	const parsedSwatches = useMemo(
		() => collectColorSwatches(swatches, 12),
		[swatches]
	);

	const selectColor = useCallback(
		(color: ColorValue) => {
			if (context.disabled || context.readOnly) {
				return;
			}
			recordRecentColor(serializeColor(color));
			store.setColorAndHsv(color, rgbToHsv(color));
		},
		[context.disabled, context.readOnly, store]
	);

	const renderGroup = useCallback(
		(label: string, entries: Array<{ color: ColorValue; value: string }>) => {
			if (entries.length === 0) {
				return null;
			}
			const currentValue = serializeColor(currentColor);
			return (
				<div aria-label={label} className="flex flex-col gap-1.5" role="group">
					<span className="text-muted-foreground text-xs">{label}</span>
					<div className="flex flex-wrap gap-1.5">
						{entries.map((entry) => {
							const selected = entry.value === currentValue;
							const paintStyle: ColorPickerPaintStyle = {
								"--color-picker-paint": colorSwatchPaint(entry.color),
							};
							return (
								<Button
									aria-label={tl("Select {group} {value}", {
										group: label.toLowerCase(),
										value: entry.value,
									})}
									aria-pressed={selected}
									className={cn(
										"corner-squircle size-7 rounded-md border border-border p-0 shadow-none transition-[transform,border-color,box-shadow] hover:scale-105 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring",
										colorSwatchPaintClass(entry.color),
										selected &&
											"border-ring ring-2 ring-ring ring-offset-1 ring-offset-popover"
									)}
									data-color-value={entry.value}
									data-slot="color-picker-swatch-button"
									disabled={context.disabled || context.readOnly}
									key={entry.value}
									onClick={() => selectColor(entry.color)}
									style={paintStyle}
									title={entry.value}
									type="button"
									variant="ghost"
								/>
							);
						})}
					</div>
				</div>
			);
		},
		[currentColor, context.disabled, context.readOnly, selectColor, tl]
	);

	if (parsedRecentColors.length === 0 && parsedSwatches.length === 0) {
		return null;
	}

	return (
		<div
			{...props}
			className={cn(
				"flex flex-col gap-3 border-border/70 border-t pt-3",
				className
			)}
			data-slot="color-picker-swatches"
		>
			{context.showRecentColors
				? renderGroup("Recent colors", parsedRecentColors)
				: null}
			{renderGroup("Swatches", parsedSwatches)}
		</div>
	);
}

export {
	ColorPickerAlphaSlider,
	ColorPickerHueSlider,
	ColorPickerSwatch,
	ColorPickerSwatches,
	type ColorPickerSwatchesProps,
	colorSwatchPaint,
	colorSwatchPaintClass,
};
