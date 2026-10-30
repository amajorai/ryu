"use client";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import {
	type ChangeEvent,
	type ComponentProps,
	useCallback,
	useMemo,
} from "react";
import {
	hslToRgb,
	parseColorString,
	rgbToHsl,
} from "./color-picker-color-format.ts";
import { oklchToRgb, rgbToHex, rgbToOklch } from "./color-picker-color-math.ts";
import type { ColorPickerInputProps } from "./color-picker-popover.tsx";
import type { ColorValue, InputElement } from "./color-picker-shared.ts";
import type { ColorPickerContextValue } from "./color-picker-store.ts";

const inputGroupItemVariants = cva(
	"h-8 [-moz-appearance:textfield] focus-visible:z-10 focus-visible:ring-1 [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none",
	{
		variants: {
			position: {
				first: "rounded-e-none",
				middle: "-ms-px rounded-none border-l-0",
				last: "-ms-px rounded-s-none border-l-0",
				isolated: "",
			},
		},
		defaultVariants: {
			position: "isolated",
		},
	}
);

interface InputGroupItemProps
	extends ComponentProps<typeof Input>,
		VariantProps<typeof inputGroupItemVariants> {}

function InputGroupItem({
	className,
	position,
	...props
}: InputGroupItemProps) {
	return (
		<Input
			className={cn(inputGroupItemVariants({ position, className }))}
			data-slot="color-picker-input"
			{...props}
		/>
	);
}

interface FormatInputProps extends ColorPickerInputProps {
	color: ColorValue;
	context: ColorPickerContextValue;
	onColorChange: (color: ColorValue) => void;
}

function HexInput(props: FormatInputProps) {
	const {
		color,
		onColorChange,
		context,
		withoutAlpha,
		className,
		...inputProps
	} = props;

	const hexValue = rgbToHex(color);
	const alphaValue = Math.round((color?.a ?? 1) * 100);

	const onHexChange = useCallback(
		(event: ChangeEvent<InputElement>) => {
			const value = event.target.value;
			const parsedColor = parseColorString(value);
			if (parsedColor) {
				onColorChange({ ...parsedColor, a: color?.a ?? 1 });
			}
		},
		[color, onColorChange]
	);

	const onAlphaChange = useCallback(
		(event: ChangeEvent<InputElement>) => {
			const value = Number.parseInt(event.target.value, 10);
			if (!Number.isNaN(value) && value >= 0 && value <= 100) {
				onColorChange({ ...color, a: value / 100 });
			}
		},
		[color, onColorChange]
	);

	if (withoutAlpha) {
		return (
			<InputGroupItem
				aria-label="Hex color value"
				position="isolated"
				{...inputProps}
				className={cn("font-mono", className)}
				disabled={context.disabled || context.readOnly}
				onChange={onHexChange}
				placeholder="#000000"
				value={hexValue}
			/>
		);
	}

	return (
		<div
			className={cn("flex items-center", className)}
			data-slot="color-picker-input-wrapper"
		>
			<InputGroupItem
				aria-label="Hex color value"
				position="first"
				{...inputProps}
				className="flex-1 font-mono"
				disabled={context.disabled || context.readOnly}
				onChange={onHexChange}
				placeholder="#000000"
				value={hexValue}
			/>
			<InputGroupItem
				aria-label="Alpha transparency percentage"
				position="last"
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="100"
				min="0"
				onChange={onAlphaChange}
				pattern="[0-9]*"
				placeholder="100"
				value={alphaValue}
			/>
		</div>
	);
}

function RgbInput(props: FormatInputProps) {
	const {
		color,
		onColorChange,
		context,
		withoutAlpha,
		className,
		...inputProps
	} = props;

	const rValue = Math.round(color?.r ?? 0);
	const gValue = Math.round(color?.g ?? 0);
	const bValue = Math.round(color?.b ?? 0);
	const alphaValue = Math.round((color?.a ?? 1) * 100);

	const onChannelChange = useCallback(
		(channel: "r" | "g" | "b" | "a", max: number, isAlpha = false) =>
			(event: ChangeEvent<InputElement>) => {
				const value = Number.parseInt(event.target.value, 10);
				if (!Number.isNaN(value) && value >= 0 && value <= max) {
					const newValue = isAlpha ? value / 100 : value;
					onColorChange({ ...color, [channel]: newValue });
				}
			},
		[color, onColorChange]
	);

	return (
		<div
			className={cn("flex items-center", className)}
			data-slot="color-picker-input-wrapper"
		>
			<InputGroupItem
				aria-label="Red color component (0-255)"
				position="first"
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="255"
				min="0"
				onChange={onChannelChange("r", 255)}
				pattern="[0-9]*"
				placeholder="0"
				value={rValue}
			/>
			<InputGroupItem
				aria-label="Green color component (0-255)"
				position="middle"
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="255"
				min="0"
				onChange={onChannelChange("g", 255)}
				pattern="[0-9]*"
				placeholder="0"
				value={gValue}
			/>
			<InputGroupItem
				aria-label="Blue color component (0-255)"
				position={withoutAlpha ? "last" : "middle"}
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="255"
				min="0"
				onChange={onChannelChange("b", 255)}
				pattern="[0-9]*"
				placeholder="0"
				value={bValue}
			/>
			{!withoutAlpha && (
				<InputGroupItem
					aria-label="Alpha transparency percentage"
					position="last"
					{...inputProps}
					className="w-14"
					disabled={context.disabled || context.readOnly}
					inputMode="numeric"
					max="100"
					min="0"
					onChange={onChannelChange("a", 100, true)}
					pattern="[0-9]*"
					placeholder="100"
					value={alphaValue}
				/>
			)}
		</div>
	);
}

function HslInput(props: FormatInputProps) {
	const {
		color,
		onColorChange,
		context,
		withoutAlpha,
		className,
		...inputProps
	} = props;

	const hsl = useMemo(() => rgbToHsl(color), [color]);
	const alphaValue = Math.round((color?.a ?? 1) * 100);

	const onHslChannelChange = useCallback(
		(channel: "h" | "s" | "l", max: number) =>
			(event: ChangeEvent<InputElement>) => {
				const value = Number.parseInt(event.target.value, 10);
				if (!Number.isNaN(value) && value >= 0 && value <= max) {
					const newHsl = { ...hsl, [channel]: value };
					const newColor = hslToRgb(newHsl, color?.a ?? 1);
					onColorChange(newColor);
				}
			},
		[hsl, color, onColorChange]
	);

	const onAlphaChange = useCallback(
		(event: ChangeEvent<InputElement>) => {
			const value = Number.parseInt(event.target.value, 10);
			if (!Number.isNaN(value) && value >= 0 && value <= 100) {
				onColorChange({ ...color, a: value / 100 });
			}
		},
		[color, onColorChange]
	);

	return (
		<div
			className={cn("flex items-center", className)}
			data-slot="color-picker-input-wrapper"
		>
			<InputGroupItem
				aria-label="Hue degree (0-360)"
				position="first"
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="360"
				min="0"
				onChange={onHslChannelChange("h", 360)}
				pattern="[0-9]*"
				placeholder="0"
				value={hsl.h}
			/>
			<InputGroupItem
				aria-label="Saturation percentage (0-100)"
				position="middle"
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="100"
				min="0"
				onChange={onHslChannelChange("s", 100)}
				pattern="[0-9]*"
				placeholder="0"
				value={hsl.s}
			/>
			<InputGroupItem
				aria-label="Lightness percentage (0-100)"
				position={withoutAlpha ? "last" : "middle"}
				{...inputProps}
				className="w-14"
				disabled={context.disabled || context.readOnly}
				inputMode="numeric"
				max="100"
				min="0"
				onChange={onHslChannelChange("l", 100)}
				pattern="[0-9]*"
				placeholder="0"
				value={hsl.l}
			/>
			{!withoutAlpha && (
				<InputGroupItem
					aria-label="Alpha transparency percentage"
					position="last"
					{...inputProps}
					className="w-14"
					disabled={context.disabled || context.readOnly}
					inputMode="numeric"
					max="100"
					min="0"
					onChange={onAlphaChange}
					pattern="[0-9]*"
					placeholder="100"
					value={alphaValue}
				/>
			)}
		</div>
	);
}

function OklchInput(props: FormatInputProps) {
	const {
		color,
		onColorChange,
		context,
		withoutAlpha,
		className,
		...inputProps
	} = props;

	const oklch = useMemo(() => rgbToOklch(color), [color]);
	const lightnessValue = Number((oklch.l * 100).toFixed(1));
	const chromaValue = Number(oklch.c.toFixed(3));
	const hueValue = Number(oklch.h.toFixed(1));
	const alphaValue = Math.round((color.a ?? 1) * 100);

	const onChannelChange = useCallback(
		(channel: "l" | "c" | "h", min: number, max: number) =>
			(event: ChangeEvent<InputElement>) => {
				const value = Number.parseFloat(event.target.value);
				if (!Number.isNaN(value) && value >= min && value <= max) {
					const next = {
						...oklch,
						[channel]: channel === "l" ? value / 100 : value,
					};
					onColorChange(oklchToRgb(next));
				}
			},
		[oklch, onColorChange]
	);

	const onAlphaChange = useCallback(
		(event: ChangeEvent<InputElement>) => {
			const value = Number.parseInt(event.target.value, 10);
			if (!Number.isNaN(value) && value >= 0 && value <= 100) {
				onColorChange(oklchToRgb({ ...oklch, a: value / 100 }));
			}
		},
		[oklch, onColorChange]
	);

	return (
		<div
			className={cn("flex items-center", className)}
			data-slot="color-picker-input-wrapper"
		>
			<InputGroupItem
				aria-label="OKLCH lightness percentage (0-100)"
				position="first"
				{...inputProps}
				className="w-16"
				disabled={context.disabled || context.readOnly}
				inputMode="decimal"
				max="100"
				min="0"
				onChange={onChannelChange("l", 0, 100)}
				placeholder="69"
				step="0.1"
				type="number"
				value={lightnessValue}
			/>
			<InputGroupItem
				aria-label="OKLCH chroma (0-0.4)"
				position="middle"
				{...inputProps}
				className="w-16"
				disabled={context.disabled || context.readOnly}
				inputMode="decimal"
				max="0.4"
				min="0"
				onChange={onChannelChange("c", 0, 0.4)}
				placeholder="0.16"
				step="0.001"
				type="number"
				value={chromaValue}
			/>
			<InputGroupItem
				aria-label="OKLCH hue degree (0-360)"
				position={withoutAlpha ? "last" : "middle"}
				{...inputProps}
				className="w-16"
				disabled={context.disabled || context.readOnly}
				inputMode="decimal"
				max="360"
				min="0"
				onChange={onChannelChange("h", 0, 360)}
				placeholder="265"
				step="0.1"
				type="number"
				value={hueValue}
			/>
			{!withoutAlpha && (
				<InputGroupItem
					aria-label="Alpha transparency percentage"
					position="last"
					{...inputProps}
					className="w-14"
					disabled={context.disabled || context.readOnly}
					inputMode="numeric"
					max="100"
					min="0"
					onChange={onAlphaChange}
					placeholder="100"
					type="number"
					value={alphaValue}
				/>
			)}
		</div>
	);
}

export { HexInput, HslInput, OklchInput, RgbInput };
