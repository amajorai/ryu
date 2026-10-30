"use client";
import { Button } from "@ryu/ui/components/button.tsx";
import { PopoverContent, PopoverTrigger } from "@ryu/ui/components/popover.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	type KeyboardEvent,
	type PointerEvent,
	type ReactElement,
	useCallback,
	useRef,
} from "react";
import styles from "./color-picker.module.css";
import { clamp, hsvToRgb } from "./color-picker-color-math.ts";
import {
	AREA_NAME,
	type AreaElement,
	CONTENT_NAME,
	type ColorPickerPaintStyle,
	type DivProps,
	derivedHexSchema,
	type HSVColorValue,
	TRIGGER_NAME,
	useSlotRender,
} from "./color-picker-shared.ts";
import { ColorPickerSwatches } from "./color-picker-sliders-swatches.tsx";
import {
	useColorPickerContext,
	useStore,
	useStoreContext,
} from "./color-picker-store.ts";

interface ColorPickerTriggerProps
	extends ComponentProps<typeof PopoverTrigger> {
	/** Existing compact theme controls, with native default behavior otherwise. */
	appearance?:
		| "default"
		| "theme-field"
		| "theme-swatch"
		| "hex-field"
		| "hex-control";
	/** Already-derived display colors; the picker never recomputes their contrast. */
	palette?: { fillHex: string; foregroundHex?: string };
	selected?: boolean;
	spectrum?: boolean;
}

function mergeHexTriggerClasses(
	className: ColorPickerTriggerProps["className"],
	recipe: string
): ColorPickerTriggerProps["className"] {
	if (isNativeFunction(className)) {
		return (state) => {
			const custom = className(state);
			return custom ? `${recipe} ${custom}` : recipe;
		};
	}
	return className ? `${recipe} ${className}` : recipe;
}

function ColorPickerTrigger(props: ColorPickerTriggerProps) {
	const {
		disabled,
		render,
		appearance = "default",
		palette,
		selected = false,
		spectrum = false,
		...triggerProps
	} = props;
	const framedTriggerProps =
		appearance === "hex-field" || appearance === "hex-control"
			? {
					...triggerProps,
					className: mergeHexTriggerClasses(
						triggerProps.className,
						appearance === "hex-field"
							? "type-caption flex h-7 cursor-pointer items-center justify-center rounded border border-border px-2 font-mono uppercase transition-opacity hover:opacity-90"
							: "flex h-8 cursor-pointer items-center justify-center rounded-md border border-border px-2 font-mono text-xs transition-opacity hover:opacity-90"
					),
				}
			: triggerProps;
	const context = useColorPickerContext(TRIGGER_NAME);
	const isDisabled = disabled || context.disabled || context.readOnly;
	const fill = derivedHexSchema.safeParse(palette?.fillHex);
	const foreground = derivedHexSchema.safeParse(palette?.foregroundHex);
	const paintStyle: ColorPickerPaintStyle = {
		"--color-picker-trigger-fill": fill.success ? fill.data : undefined,
		"--color-picker-trigger-foreground": foreground.success
			? foreground.data
			: undefined,
	};
	const buttonAppearance =
		appearance === "theme-field"
			? "theme-field"
			: appearance === "theme-swatch"
				? selected
					? "theme-swatch-selected"
					: "theme-swatch"
				: "default";
	// Invalid legacy display hex leaves the native button's background intact.
	// Spectrum owns the original background shorthand, including its resets.
	const paintClass = cn(
		appearance === "theme-swatch" && spectrum
			? styles.spectrumFill
			: fill.success &&
					(appearance === "theme-swatch"
						? styles.swatchFill
						: styles.fieldFill),
		foreground.success && styles.triggerForeground
	);
	return (
		<PopoverTrigger
			data-slot="color-picker-trigger"
			disabled={isDisabled}
			render={
				render ?? (
					<Button
						appearance={buttonAppearance}
						className={paintClass}
						style={paintStyle}
					/>
				)
			}
			{...framedTriggerProps}
		/>
	);
}

function ColorPickerContent(
	props: ComponentProps<typeof PopoverContent> & { asChild?: boolean }
) {
	const { asChild, className, children, ...popoverContentProps } = props;

	const context = useColorPickerContext(CONTENT_NAME);
	const content = (
		<>
			{children}
			{(context.showRecentColors || context.swatches.length > 0) && (
				<ColorPickerSwatches />
			)}
		</>
	);

	const inlineElement = useSlotRender(asChild, {
		"data-slot": "color-picker-content",
		className: cn("flex w-[340px] flex-col gap-4 p-4", className),
		children: content,
	});

	if (context.inline) {
		return inlineElement;
	}

	return (
		<PopoverContent
			data-slot="color-picker-content"
			{...popoverContentProps}
			className={cn("flex w-[340px] flex-col gap-4 p-4", className)}
		>
			{content}
		</PopoverContent>
	);
}

function ColorPickerArea(props: DivProps): ReactElement {
	const {
		asChild,
		onPointerDown: onPointerDownProp,
		onPointerMove: onPointerMoveProp,
		onPointerUp: onPointerUpProp,
		onKeyDown: onKeyDownProp,
		className,
		ref,
		...areaProps
	} = props;

	const propsRef = useAsRef({
		onPointerDown: onPointerDownProp,
		onPointerMove: onPointerMoveProp,
		onPointerUp: onPointerUpProp,
		onKeyDown: onKeyDownProp,
	});

	const context = useColorPickerContext(AREA_NAME);
	const store = useStoreContext(AREA_NAME);

	const hsv = useStore((state) => state.hsv);

	const isDraggingRef = useRef(false);
	const areaRef = useRef<HTMLDivElement>(null);
	const composedRef = useComposedRefs(ref, areaRef);

	const updateColorFromPosition = useCallback(
		(clientX: number, clientY: number) => {
			if (!areaRef.current) {
				return;
			}

			const rect = areaRef.current.getBoundingClientRect();
			const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
			const y = Math.max(
				0,
				Math.min(1, 1 - (clientY - rect.top) / rect.height)
			);

			const newHsv: HSVColorValue = {
				h: hsv?.h ?? 0,
				s: Math.round(x * 100),
				v: Math.round(y * 100),
				a: hsv?.a ?? 1,
			};

			store.setColorAndHsv(hsvToRgb(newHsv), newHsv);
		},
		[hsv, store]
	);

	const onPointerDown = useCallback(
		(event: PointerEvent<AreaElement>) => {
			if (context.disabled || context.readOnly) {
				return;
			}
			propsRef.current.onPointerDown?.(event);
			if (event.defaultPrevented) {
				return;
			}

			isDraggingRef.current = true;
			areaRef.current?.setPointerCapture(event.pointerId);
			updateColorFromPosition(event.clientX, event.clientY);
		},
		[context.disabled, updateColorFromPosition, propsRef]
	);

	const onPointerMove = useCallback(
		(event: PointerEvent<AreaElement>) => {
			propsRef.current.onPointerMove?.(event);
			if (event.defaultPrevented) {
				return;
			}

			if (isDraggingRef.current) {
				updateColorFromPosition(event.clientX, event.clientY);
			}
		},
		[updateColorFromPosition, propsRef]
	);

	const onPointerUp = useCallback(
		(event: PointerEvent<AreaElement>) => {
			propsRef.current.onPointerUp?.(event);
			if (event.defaultPrevented) {
				return;
			}

			isDraggingRef.current = false;
			areaRef.current?.releasePointerCapture(event.pointerId);
		},
		[propsRef]
	);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<AreaElement>) => {
			propsRef.current.onKeyDown?.(event);
			if (event.defaultPrevented || context.disabled || context.readOnly) {
				return;
			}
			const step = event.shiftKey ? 10 : 1;
			const nextHsv = { ...hsv };
			switch (event.key) {
				case "ArrowLeft":
					nextHsv.s = clamp(nextHsv.s - step, 0, 100);
					break;
				case "ArrowRight":
					nextHsv.s = clamp(nextHsv.s + step, 0, 100);
					break;
				case "ArrowDown":
					nextHsv.v = clamp(nextHsv.v - step, 0, 100);
					break;
				case "ArrowUp":
					nextHsv.v = clamp(nextHsv.v + step, 0, 100);
					break;
				default:
					return;
			}
			event.preventDefault();
			store.setColorAndHsv(hsvToRgb(nextHsv), nextHsv);
		},
		[context.disabled, context.readOnly, hsv, propsRef, store]
	);

	const hue = hsv?.h ?? 0;
	const backgroundHue = hsvToRgb({ h: hue, s: 100, v: 100, a: 1 });
	const areaColorStyle: ColorPickerPaintStyle = {
		"--color-picker-area-r": backgroundHue.r,
		"--color-picker-area-g": backgroundHue.g,
		"--color-picker-area-b": backgroundHue.b,
	};
	const areaHandleStyle: ColorPickerPaintStyle = {
		"--color-picker-area-left": `${hsv?.s ?? 0}%`,
		"--color-picker-area-top": `${100 - (hsv?.v ?? 0)}%`,
	};

	return useSlotRender(asChild, {
		...areaProps,
		"data-slot": "color-picker-area",
		className: cn(
			"corner-squircle relative h-40 w-full cursor-crosshair touch-none rounded-sm border",
			(context.disabled || context.readOnly) &&
				"pointer-events-none opacity-50",
			className
		),
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onKeyDown,
		role: "group",
		tabIndex: context.disabled || context.readOnly ? -1 : 0,
		"aria-label": "Saturation and brightness",
		ref: composedRef,
		children: (
			<>
				<div className="corner-squircle absolute inset-0 overflow-hidden rounded-sm">
					<div
						className={cn("absolute inset-0", styles.areaHue)}
						style={areaColorStyle}
					/>
					<div className={cn("absolute inset-0", styles.areaWhite)} />
					<div className={cn("absolute inset-0", styles.areaBlack)} />
				</div>
				<div
					className={cn(
						"absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm",
						styles.areaHandle
					)}
					style={areaHandleStyle}
				/>
			</>
		),
	});
}

export {
	ColorPickerArea,
	ColorPickerContent,
	ColorPickerTrigger,
	type ColorPickerTriggerProps,
};
