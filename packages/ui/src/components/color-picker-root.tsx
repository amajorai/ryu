"use client";
import { useDirection } from "@base-ui/react/direction-provider";
import { Popover } from "@ryu/ui/components/popover.tsx";
import { VisuallyHiddenInput } from "@ryu/ui/components/visually-hidden-input.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { useIsomorphicLayoutEffect } from "@ryu/ui/hooks/use-isomorphic-layout-effect.ts";
import { useLazyRef } from "@ryu/ui/hooks/use-lazy-ref.ts";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import {
	type ComponentProps,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	colorToString,
	parseColorString,
	serializeColor,
	toParsedColor,
} from "./color-picker-color-format.ts";
import {
	EMPTY_COLOR,
	hsvToRgb,
	rgbToHex,
	rgbToHsv,
} from "./color-picker-color-math.ts";
import {
	type ColorFormat,
	type ColorValue,
	type DivProps,
	type HSVColorValue,
	type ParsedColor,
	ROOT_IMPL_NAME,
	type RootElement,
	useSlotRender,
} from "./color-picker-shared.ts";
import {
	ColorPickerContext,
	type ColorPickerContextValue,
	type Direction,
	recordRecentColor,
	type Store,
	StoreContext,
	type StoreState,
	useStore,
	useStoreContext,
} from "./color-picker-store.ts";

interface ColorPickerProps
	extends Omit<DivProps, "onValueChange">,
		Pick<ComponentProps<typeof Popover>, "defaultOpen" | "open" | "modal"> {
	asChild?: boolean;
	defaultFormat?: ColorFormat;
	defaultValue?: string;
	dir?: Direction;
	disabled?: boolean;
	format?: ColorFormat;
	inline?: boolean;
	name?: string;
	onFormatChange?: (format: ColorFormat) => void;
	// Decoupled from Base UI's `(open, eventDetails) => void` so the color picker
	// exposes the simpler single-arg callback its store dispatches internally.
	onOpenChange?: (open: boolean) => void;
	onValueChange?: (value: string, parsed?: ParsedColor) => void;
	readOnly?: boolean;
	required?: boolean;
	/** Keep the shared recent-color history visible in the panel. */
	showRecentColors?: boolean;
	/** Optional preset colors shown in the built-in swatch strip. */
	swatches?: string[];
	value?: string;
}

function ColorPicker(props: ColorPickerProps) {
	const {
		value: valueProp,
		defaultValue = "#000000",
		onValueChange,
		format: formatProp,
		defaultFormat = "hex",
		onFormatChange,
		defaultOpen,
		open: openProp,
		onOpenChange,
		name,
		disabled,
		inline,
		readOnly,
		required,
		showRecentColors = true,
		swatches = [],
		...rootProps
	} = props;

	const listenersRef = useLazyRef(() => new Set<() => void>());
	const stateRef = useLazyRef<StoreState>(() => {
		const colorString = valueProp ?? defaultValue;
		const color = parseColorString(colorString) ?? { ...EMPTY_COLOR };

		return {
			color,
			hsv: rgbToHsv(color),
			open: openProp ?? defaultOpen ?? false,
			format: formatProp ?? defaultFormat,
		};
	});

	const propsRef = useAsRef({
		onValueChange,
		onOpenChange,
		onFormatChange,
	});

	const store = useMemo<Store>(() => {
		return {
			subscribe: (cb) => {
				listenersRef.current.add(cb);
				return () => listenersRef.current.delete(cb);
			},
			getState: () => stateRef.current,
			setColor: (value: ColorValue) => {
				if (Object.is(stateRef.current.color, value)) {
					return;
				}

				const prevState = { ...stateRef.current };
				stateRef.current.color = value;

				if (propsRef.current.onValueChange) {
					const colorString = colorToString(value, prevState.format);
					propsRef.current.onValueChange(colorString, toParsedColor(value));
				}

				store.notify();
			},
			setColorAndHsv: (color: ColorValue, hsv: HSVColorValue) => {
				const prevState = { ...stateRef.current };
				stateRef.current.color = color;
				stateRef.current.hsv = hsv;

				if (
					!Object.is(prevState.color, color) &&
					propsRef.current.onValueChange
				) {
					const colorString = colorToString(color, prevState.format);
					propsRef.current.onValueChange(colorString, toParsedColor(color));
				}

				store.notify();
			},
			setHsv: (value: HSVColorValue) => {
				if (Object.is(stateRef.current.hsv, value)) {
					return;
				}

				const prevState = { ...stateRef.current };
				stateRef.current.hsv = value;

				if (propsRef.current.onValueChange) {
					const colorValue = hsvToRgb(value);
					const colorString = colorToString(colorValue, prevState.format);
					propsRef.current.onValueChange(
						colorString,
						toParsedColor(colorValue)
					);
				}

				store.notify();
			},
			// Sync internal state from the controlled `value` prop WITHOUT echoing
			// `onValueChange`. An external value change is not a user edit, so firing
			// the callback here would (a) mark consumers dirty on mount and (b) push a
			// lossy round-tripped color back up. Both setColor/setHsv would otherwise
			// notify the parent, so this dedicated path keeps the sync silent.
			syncFromValue: (color: ColorValue, hsv: HSVColorValue) => {
				stateRef.current.color = color;
				stateRef.current.hsv = hsv;
				store.notify();
			},
			setOpen: (value: boolean) => {
				if (Object.is(stateRef.current.open, value)) {
					return;
				}

				stateRef.current.open = value;

				if (propsRef.current.onOpenChange) {
					propsRef.current.onOpenChange(value);
				}

				store.notify();
			},
			setFormat: (value: ColorFormat) => {
				if (Object.is(stateRef.current.format, value)) {
					return;
				}

				stateRef.current.format = value;

				if (propsRef.current.onFormatChange) {
					propsRef.current.onFormatChange(value);
				}

				store.notify();
			},
			notify: () => {
				for (const cb of listenersRef.current) {
					cb();
				}
			},
		};
	}, [listenersRef, stateRef, propsRef]);

	return (
		<StoreContext.Provider value={store}>
			<ColorPickerImpl
				{...rootProps}
				defaultOpen={defaultOpen}
				disabled={disabled}
				inline={inline}
				name={name}
				open={openProp}
				readOnly={readOnly}
				required={required}
				showRecentColors={showRecentColors}
				swatches={swatches}
				value={valueProp}
			/>
		</StoreContext.Provider>
	);
}

interface ColorPickerImplProps
	extends Omit<
		ColorPickerProps,
		| "defaultValue"
		| "onValueChange"
		| "onOpenChange"
		| "format"
		| "defaultFormat"
		| "onFormatChange"
	> {}

function ColorPickerImpl(props: ColorPickerImplProps) {
	const {
		value: valueProp,
		dir: dirProp,
		defaultOpen,
		open: openProp,
		name,
		ref,
		asChild,
		disabled,
		inline,
		modal,
		readOnly,
		required,
		showRecentColors = true,
		swatches = [],
		...rootProps
	} = props;

	const store = useStoreContext(ROOT_IMPL_NAME);

	// Base UI's `useDirection` reads from context and takes no local override, so
	// honor an explicit `dir` prop first, then fall back to the ambient direction.
	const contextDir = useDirection();
	const dir = dirProp ?? contextDir;

	const [formTrigger, setFormTrigger] = useState<RootElement | null>(null);
	const composedRef = useComposedRefs(ref, (node) => setFormTrigger(node));
	const isFormControl = formTrigger ? !!formTrigger.closest("form") : true;

	useIsomorphicLayoutEffect(() => {
		if (valueProp === undefined) {
			return;
		}
		const currentState = store.getState();
		const color = parseColorString(valueProp);
		if (!color) {
			return;
		}
		// Skip when the incoming value already matches internal state, so an
		// external prop that equals the current color doesn't trigger a re-sync.
		if (
			rgbToHex(currentState.color).toLowerCase() ===
				rgbToHex(color).toLowerCase() &&
			Math.abs(currentState.color.a - color.a) < 0.005
		) {
			return;
		}
		const hsv = rgbToHsv(color);
		store.syncFromValue(color, hsv);
	}, [store, valueProp]);

	useIsomorphicLayoutEffect(() => {
		if (openProp !== undefined) {
			store.setOpen(openProp);
		}
	}, [openProp]);

	const contextValue = useMemo<ColorPickerContextValue>(
		() => ({
			dir,
			disabled,
			inline,
			readOnly,
			required,
			showRecentColors,
			swatches,
		}),
		[dir, disabled, inline, readOnly, required, showRecentColors, swatches]
	);

	const color = useStore((state) => state.color);
	const recentColor = useMemo(() => serializeColor(color), [color]);
	const lastRecentColor = useRef(recentColor);
	useEffect(() => {
		if (lastRecentColor.current === recentColor) {
			return;
		}
		lastRecentColor.current = recentColor;
		const timer = setTimeout(() => recordRecentColor(recentColor), 350);
		return () => clearTimeout(timer);
	}, [recentColor]);

	const value = recentColor;
	const open = useStore((state) => state.open);

	const rootElement = useSlotRender(asChild, {
		...rootProps,
		ref: composedRef,
	});

	if (inline) {
		return (
			<ColorPickerContext.Provider value={contextValue}>
				{rootElement}
				{isFormControl && (
					<VisuallyHiddenInput
						control={formTrigger}
						disabled={disabled}
						name={name}
						readOnly={readOnly}
						required={required}
						type="hidden"
						value={value}
					/>
				)}
			</ColorPickerContext.Provider>
		);
	}

	return (
		<ColorPickerContext.Provider value={contextValue}>
			<Popover
				defaultOpen={defaultOpen}
				modal={modal}
				onOpenChange={store.setOpen}
				open={open}
			>
				{rootElement}
				{isFormControl && (
					<VisuallyHiddenInput
						control={formTrigger}
						disabled={disabled}
						name={name}
						readOnly={readOnly}
						required={required}
						type="hidden"
						value={value}
					/>
				)}
			</Popover>
		</ColorPickerContext.Provider>
	);
}

export { ColorPicker, type ColorPickerProps };
