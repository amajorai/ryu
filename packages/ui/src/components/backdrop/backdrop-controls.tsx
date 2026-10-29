"use client";

// packages/ui/src/components/backdrop/backdrop-controls.tsx
//
// Customization controls generated from a backdrop's param schema: sliders for
// numbers, colour swatches for colours and colour lists, switches for toggles,
// and segmented choices for selects. The same component edits wallpapers,
// banners and anything else that renders a `<Backdrop>`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Plus, RotateCcw, X } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { z } from "zod";
import { Button } from "../button.tsx";
import { Slider } from "../slider.tsx";
import { Switch } from "../switch.tsx";
import type { BackdropDefinition } from "./definitions.ts";
import {
	type BackdropParamSpec,
	type BackdropParams,
	type BackdropParamValue,
	defaultBackdropParams,
	resolveBackdropParams,
} from "./params.ts";

/** `<input type="color">` only understands #rrggbb. */
function toHex6(value: string): string {
	const hex = value.trim();
	if (/^#[0-9a-f]{6}/i.test(hex)) {
		return hex.slice(0, 7);
	}
	if (/^#[0-9a-f]{3,4}$/i.test(hex)) {
		return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
	}
	return "#000000";
}

/** Keep an existing alpha suffix when the picker hands back #rrggbb. */
function withAlpha(previous: string, next: string): string {
	const alpha = /^#[0-9a-f]{8}$/i.test(previous) ? previous.slice(7) : "";
	return `${next}${alpha}`;
}

interface BackdropSwatchInputs extends CSSProperties {
	"--ryu-backdrop-swatch-background": string;
}

function Swatch({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	value: string;
}) {
	const style: BackdropSwatchInputs = {
		"--ryu-backdrop-swatch-background": value,
	};
	return (
		<label
			className="ryu-backdrop-swatch relative block size-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border shadow-sm"
			style={style}
			title={`${label}: ${value}`}
		>
			<input
				aria-label={label}
				className="absolute inset-0 cursor-pointer opacity-0"
				onChange={(event) => onChange(withAlpha(value, event.target.value))}
				type="color"
				value={toHex6(value)}
			/>
		</label>
	);
}

function formatNumber(
	spec: Extract<BackdropParamSpec, { kind: "number" }>,
	value: number
) {
	return spec.step >= 1 ? value.toFixed(0) : value.toFixed(2);
}

function Control({
	onChange,
	spec,
	value,
}: {
	onChange: (value: BackdropParamValue) => void;
	spec: BackdropParamSpec;
	value: BackdropParamValue;
}) {
	const id = useId();
	const tl = useLiteralMessages();
	switch (spec.kind) {
		case "number": {
			const parsed = z
				.union([
					z.number(),
					z.nan(),
					z.literal(Number.POSITIVE_INFINITY),
					z.literal(Number.NEGATIVE_INFINITY),
				])
				.safeParse(value);
			const current = parsed.success ? parsed.data : spec.default;
			return (
				<div className="grid gap-2">
					<div className="flex items-center justify-between text-xs">
						<label className="font-medium" htmlFor={id}>
							{spec.label}
						</label>
						<span className="text-muted-foreground tabular-nums">
							{formatNumber(spec, current)}
						</span>
					</div>
					<Slider
						aria-label={spec.label}
						id={id}
						max={spec.max}
						min={spec.min}
						onValueChange={(next) =>
							onChange(Array.isArray(next) ? next[0] : next)
						}
						step={spec.step}
						value={[current]}
					/>
				</div>
			);
		}
		case "color": {
			const color = z.string().safeParse(value);
			return (
				<div className="flex items-center justify-between gap-3">
					<span className="font-medium text-xs">{spec.label}</span>
					<Swatch
						label={spec.label}
						onChange={onChange}
						value={color.success ? color.data : spec.default}
					/>
				</div>
			);
		}
		case "colors": {
			const colors = z.array(z.string()).safeParse(value);
			const list = colors.success ? colors.data : [...spec.default];
			return (
				<div className="grid gap-2">
					<span className="font-medium text-xs">{spec.label}</span>
					<div className="flex flex-wrap items-center gap-1.5">
						{list.map((item, index) => (
							<div
								className="group relative"
								key={`${index.toString()}-${item}`}
							>
								<Swatch
									label={`${spec.label} ${index + 1}`}
									onChange={(next) =>
										onChange(list.map((old, i) => (i === index ? next : old)))
									}
									value={item}
								/>
								{list.length > spec.min ? (
									<button
										aria-label={tl("Remove colour {position}", {
											position: index + 1,
										})}
										className="absolute -top-1 -right-1 hidden size-4 items-center justify-center rounded-full bg-background text-muted-foreground shadow group-hover:flex"
										onClick={() => onChange(list.filter((_, i) => i !== index))}
										type="button"
									>
										<X className="size-2.5" />
									</button>
								) : null}
							</div>
						))}
						{list.length < spec.max ? (
							<button
								aria-label={tl("Add {label} colour", {
									label: spec.label.toLowerCase(),
								})}
								className="flex size-7 items-center justify-center rounded-full border border-border border-dashed text-muted-foreground hover:bg-muted"
								onClick={() => onChange([...list, list.at(-1) ?? "#ffffff"])}
								type="button"
							>
								<Plus className="size-3.5" />
							</button>
						) : null}
					</div>
				</div>
			);
		}
		case "boolean":
			return (
				<div className="flex items-center justify-between gap-3">
					<label className="font-medium text-xs" htmlFor={id}>
						{spec.label}
					</label>
					<Switch
						checked={value === true}
						id={id}
						onCheckedChange={(checked) => onChange(checked)}
						size="sm"
					/>
				</div>
			);
		case "select":
			return (
				<div className="grid gap-2">
					<span className="font-medium text-xs">{spec.label}</span>
					<div className="flex flex-wrap gap-1">
						{spec.options.map((option) => (
							<button
								aria-pressed={value === option}
								className={
									value === option
										? "rounded-full bg-primary px-2.5 py-1 text-primary-foreground text-xs"
										: "rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted"
								}
								key={option}
								onClick={() => onChange(option)}
								type="button"
							>
								{option}
							</button>
						))}
					</div>
				</div>
			);
		default:
			return null;
	}
}

export function BackdropControls({
	definition,
	onChange,
	params,
}: {
	definition: BackdropDefinition;
	onChange: (params: BackdropParams) => void;
	params: Parameters<typeof resolveBackdropParams>[1];
}) {
	const resolved = resolveBackdropParams(definition.params, params);
	if (definition.params.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				This background has no settings.
			</p>
		);
	}
	return (
		<div className="grid gap-4">
			{definition.params.map((spec) => (
				<Control
					key={spec.key}
					onChange={(value) => onChange({ ...resolved, [spec.key]: value })}
					spec={spec}
					value={resolved[spec.key]}
				/>
			))}
			<Button
				className="justify-self-start"
				onClick={() => onChange(defaultBackdropParams(definition.params))}
				size="sm"
				variant="ghost"
			>
				<RotateCcw className="size-3.5" />
				Reset to defaults
			</Button>
		</div>
	);
}
