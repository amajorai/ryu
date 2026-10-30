"use client";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Button } from "@ryu/ui/components/button.tsx";
import type { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { PipetteIcon } from "lucide-react";
import { type ComponentProps, type CSSProperties, useCallback } from "react";
import styles from "./color-picker.module.css";
import { serializeColor } from "./color-picker-color-format.ts";
import { hexToRgb, rgbToHsv } from "./color-picker-color-math.ts";
import {
	HexInput,
	HslInput,
	OklchInput,
	RgbInput,
} from "./color-picker-format-inputs.tsx";
import { ColorPicker, type ColorPickerProps } from "./color-picker-root.tsx";
import {
	type ColorPickerPaintStyle,
	type ColorValue,
	colorFormatSchema,
	colorFormats,
	EYE_DROPPER_NAME,
	FORMAT_ITEMS,
	FORMAT_SELECT_NAME,
	INPUT_NAME,
} from "./color-picker-shared.ts";
import {
	ColorPickerAlphaSlider,
	ColorPickerHueSlider,
	colorSwatchPaint,
	colorSwatchPaintClass,
} from "./color-picker-sliders-swatches.tsx";
import {
	useColorPickerContext,
	useStore,
	useStoreContext,
} from "./color-picker-store.ts";
import {
	ColorPickerArea,
	ColorPickerContent,
	ColorPickerTrigger,
} from "./color-picker-trigger-area.tsx";

interface ColorPickerPanelProps extends ComponentProps<"div"> {
	showEyeDropper?: boolean;
	withoutAlpha?: boolean;
}

function ColorPickerPanel({
	className,
	showEyeDropper = true,
	withoutAlpha,
	...props
}: ColorPickerPanelProps) {
	return (
		<div
			{...props}
			className={cn("flex flex-col gap-3", className)}
			data-slot="color-picker-panel"
		>
			<ColorPickerArea />
			<ColorPickerHueSlider aria-label="Hue" />
			{!withoutAlpha && <ColorPickerAlphaSlider aria-label="Alpha" />}
			<div className="flex min-w-0 items-center gap-2">
				<ColorPickerFormatSelect className="w-[4.75rem] shrink-0" />
				<ColorPickerInput
					className="min-w-0 flex-1"
					withoutAlpha={withoutAlpha}
				/>
				{showEyeDropper && (
					<ColorPickerEyeDropper aria-label="Pick color from screen" />
				)}
			</div>
		</div>
	);
}

interface ColorPickerPopoverProps extends Omit<ColorPickerProps, "children"> {
	triggerAriaLabel?: string;
	triggerClassName?: string;
	triggerShowValue?: boolean;
	triggerStyle?: CSSProperties;
}

/** Map convenience names to native trigger props, retaining the public SDK style contract. */
function popoverTriggerPresentation(
	presentation: Pick<
		ColorPickerPopoverProps,
		"triggerAriaLabel" | "triggerClassName" | "triggerStyle"
	>
): Pick<PopoverPrimitive.Trigger.Props, "aria-label" | "className" | "style"> {
	return {
		"aria-label": presentation.triggerAriaLabel,
		className: cn(
			"corner-squircle inline-flex h-8 min-w-12 items-center justify-center gap-2 rounded-md border border-border bg-background px-2 text-foreground hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50",
			presentation.triggerClassName
		),
		style: presentation.triggerStyle,
	};
}

function ColorPickerPopoverTrigger({
	triggerAriaLabel = "Choose color",
	triggerClassName,
	triggerShowValue = true,
	triggerStyle,
}: Pick<
	ColorPickerPopoverProps,
	"triggerAriaLabel" | "triggerClassName" | "triggerShowValue" | "triggerStyle"
>) {
	const color = useStore((state) => state.color);
	const displayValue = serializeColor(color);
	const paintStyle: ColorPickerPaintStyle = {
		"--color-picker-paint": colorSwatchPaint(color),
	};
	// Preserve the native public triggerStyle contract through SDK prop forwarding.
	const triggerProps = popoverTriggerPresentation({
		triggerAriaLabel,
		triggerClassName,
		triggerStyle,
	});

	return (
		<ColorPickerTrigger
			aria-label={triggerAriaLabel}
			className={cn(
				"corner-squircle inline-flex h-8 min-w-12 items-center justify-center gap-2 rounded-md border border-border bg-background px-2 text-foreground hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50",
				triggerClassName
			)}
			{...triggerProps}
		>
			<span
				aria-hidden="true"
				className={cn(
					"corner-squircle size-5 shrink-0 rounded-sm border border-foreground/15",
					styles.forcedColorsNone,
					colorSwatchPaintClass(color)
				)}
				style={paintStyle}
			/>
			{triggerShowValue && (
				<span className="font-mono text-xs uppercase">{displayValue}</span>
			)}
		</ColorPickerTrigger>
	);
}

function ColorPickerPopover({
	defaultValue = "#000000",
	triggerAriaLabel = "Choose color",
	triggerClassName,
	triggerShowValue = true,
	triggerStyle,
	value,
	...props
}: ColorPickerPopoverProps) {
	return (
		<ColorPicker {...props} defaultValue={defaultValue} value={value}>
			<ColorPickerPopoverTrigger
				triggerAriaLabel={triggerAriaLabel}
				triggerClassName={triggerClassName}
				triggerShowValue={triggerShowValue}
				triggerStyle={triggerStyle}
			/>
			<ColorPickerContent>
				<ColorPickerPanel />
			</ColorPickerContent>
		</ColorPicker>
	);
}

function ColorPickerEyeDropper(props: ComponentProps<typeof Button>) {
	const { size: sizeProp, children, disabled, ...buttonProps } = props;

	const context = useColorPickerContext(EYE_DROPPER_NAME);
	const store = useStoreContext(EYE_DROPPER_NAME);

	const color = useStore((state) => state.color);

	const isDisabled = disabled || context.disabled || context.readOnly;

	const onEyeDropper = useCallback(async () => {
		if (!window.EyeDropper) {
			return;
		}

		try {
			const eyeDropper = new window.EyeDropper();
			const result = await eyeDropper.open();

			if (result.sRGBHex) {
				const currentAlpha = color?.a ?? 1;
				const newColor = hexToRgb(result.sRGBHex, currentAlpha);
				const newHsv = rgbToHsv(newColor);
				store.setColorAndHsv(newColor, newHsv);
			}
		} catch (error) {
			console.warn("EyeDropper error:", error);
		}
	}, [color, store]);

	const hasEyeDropper = globalThis.window !== undefined && !!window.EyeDropper;

	if (!hasEyeDropper) {
		return null;
	}

	const size = sizeProp ?? (children ? "default" : "icon");

	return (
		<Button
			data-slot="color-picker-eye-dropper"
			{...buttonProps}
			aria-label={buttonProps["aria-label"] ?? "Pick color from screen"}
			disabled={isDisabled}
			onClick={onEyeDropper}
			size={size}
			variant="outline"
		>
			{children ?? <PipetteIcon />}
		</Button>
	);
}

interface ColorPickerFormatSelectProps
	extends Omit<ComponentProps<typeof Select>, "value" | "onValueChange">,
		Pick<ComponentProps<typeof SelectTrigger>, "size" | "className"> {}

function ColorPickerFormatSelect(props: ColorPickerFormatSelectProps) {
	const { size, disabled, className, ...selectProps } = props;

	const context = useColorPickerContext(FORMAT_SELECT_NAME);
	const store = useStoreContext(FORMAT_SELECT_NAME);
	const isDisabled = disabled || context.disabled || context.readOnly;

	const format = useStore((state) => state.format);

	const onFormatChange: NonNullable<
		ComponentProps<typeof Select>["onValueChange"]
	> = useCallback(
		(value) => {
			const formatInput = colorFormatSchema.safeParse(value);
			if (formatInput.success) {
				store.setFormat(formatInput.data);
			}
		},
		[store]
	);

	return (
		<Select
			{...selectProps}
			disabled={isDisabled}
			items={FORMAT_ITEMS}
			onValueChange={onFormatChange}
			value={format}
		>
			<SelectTrigger
				className={cn(className)}
				data-slot="color-picker-format-select-trigger"
				size={size ?? "sm"}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{colorFormats.map((format) => (
					<SelectItem key={format} value={format}>
						{format.toUpperCase()}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

interface ColorPickerInputProps
	extends Omit<ComponentProps<typeof Input>, "value" | "onChange" | "color"> {
	withoutAlpha?: boolean;
}

function ColorPickerInput(props: ColorPickerInputProps) {
	const store = useStoreContext(INPUT_NAME);
	const context = useColorPickerContext(INPUT_NAME);

	const color = useStore((state) => state.color);
	const format = useStore((state) => state.format);

	const onColorChange = useCallback(
		(newColor: ColorValue) => {
			const newHsv = rgbToHsv(newColor);
			store.setColorAndHsv(newColor, newHsv);
		},
		[store]
	);

	if (format === "hex") {
		return (
			<HexInput
				color={color}
				context={context}
				onColorChange={onColorChange}
				{...props}
			/>
		);
	}

	if (format === "rgb") {
		return (
			<RgbInput
				color={color}
				context={context}
				onColorChange={onColorChange}
				{...props}
			/>
		);
	}

	if (format === "hsl") {
		return (
			<HslInput
				color={color}
				context={context}
				onColorChange={onColorChange}
				{...props}
			/>
		);
	}

	if (format === "oklch") {
		return (
			<OklchInput
				color={color}
				context={context}
				onColorChange={onColorChange}
				{...props}
			/>
		);
	}
}

export {
	ColorPickerEyeDropper,
	ColorPickerFormatSelect,
	ColorPickerInput,
	type ColorPickerInputProps,
	ColorPickerPanel,
	type ColorPickerPanelProps,
	ColorPickerPopover,
	type ColorPickerPopoverProps,
};
