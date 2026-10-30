"use client";
import {
	createContext,
	useCallback,
	useContext,
	useSyncExternalStore,
} from "react";
import {
	collectColorSwatches,
	parseColorString,
	serializeColor,
} from "./color-picker-color-format.ts";
import {
	type ColorFormat,
	type ColorValue,
	type HSVColorValue,
	ROOT_NAME,
	recentColorStringsSchema,
} from "./color-picker-shared.ts";

type Direction = "ltr" | "rtl";

const RECENT_COLORS_STORAGE_KEY = "ryu:color-picker:recent-colors";
const MAX_RECENT_COLORS = 8;
const EMPTY_RECENT_COLORS: string[] = [];
let recentColorsState: string[] = EMPTY_RECENT_COLORS;
let recentColorsLoaded = false;
const recentColorsListeners = new Set<() => void>();

function loadRecentColors(): void {
	if (recentColorsLoaded || globalThis.window === undefined) {
		return;
	}
	recentColorsLoaded = true;
	try {
		const stored = recentColorStringsSchema.parse(
			JSON.parse(window.localStorage.getItem(RECENT_COLORS_STORAGE_KEY) ?? "[]")
		);
		const parsed = collectColorSwatches(stored, MAX_RECENT_COLORS).map(
			(entry) => entry.value
		);
		recentColorsState = parsed;
	} catch {
		// Recent colors are a convenience. A blocked or malformed browser store
		// must never prevent the picker from rendering.
	}
}

function writeRecentColors(): void {
	if (globalThis.window === undefined) {
		return;
	}
	try {
		window.localStorage.setItem(
			RECENT_COLORS_STORAGE_KEY,
			JSON.stringify(recentColorsState)
		);
	} catch {
		// Private browsing and embedded documents may deny localStorage writes.
	}
}

function notifyRecentColors(): void {
	for (const listener of recentColorsListeners) {
		listener();
	}
}

function subscribeRecentColors(listener: () => void): () => void {
	loadRecentColors();
	recentColorsListeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key !== RECENT_COLORS_STORAGE_KEY) {
			return;
		}
		recentColorsLoaded = false;
		loadRecentColors();
		notifyRecentColors();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		recentColorsListeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

function getRecentColorsSnapshot(): string[] {
	loadRecentColors();
	return recentColorsState;
}

function recordRecentColor(value: string): void {
	loadRecentColors();
	const color = parseColorString(value);
	if (!color) {
		return;
	}
	const normalized = serializeColor(color);
	const next = [
		normalized,
		...recentColorsState.filter((recent) => recent !== normalized),
	].slice(0, MAX_RECENT_COLORS);
	if (next.every((recent, index) => recent === recentColorsState[index])) {
		return;
	}
	recentColorsState = next;
	writeRecentColors();
	notifyRecentColors();
}

function useRecentColors(): string[] {
	return useSyncExternalStore(
		subscribeRecentColors,
		getRecentColorsSnapshot,
		() => EMPTY_RECENT_COLORS
	);
}

interface StoreState {
	color: ColorValue;
	format: ColorFormat;
	hsv: HSVColorValue;
	open: boolean;
}

interface Store {
	getState: () => StoreState;
	notify: () => void;
	setColor: (value: ColorValue) => void;
	setColorAndHsv: (color: ColorValue, hsv: HSVColorValue) => void;
	setFormat: (value: ColorFormat) => void;
	setHsv: (value: HSVColorValue) => void;
	setOpen: (value: boolean) => void;
	subscribe: (cb: () => void) => () => void;
	syncFromValue: (color: ColorValue, hsv: HSVColorValue) => void;
}

const StoreContext = createContext<Store | null>(null);

function useStoreContext(consumerName: string) {
	const context = useContext(StoreContext);
	if (!context) {
		throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
	}
	return context;
}

function useStore<U>(selector: (state: StoreState) => U): U {
	const store = useStoreContext("useStore");

	const getSnapshot = useCallback(
		() => selector(store.getState()),
		[store, selector]
	);

	return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

interface ColorPickerContextValue {
	dir: Direction;
	disabled?: boolean;
	inline?: boolean;
	readOnly?: boolean;
	required?: boolean;
	showRecentColors: boolean;
	swatches: string[];
}

const ColorPickerContext = createContext<ColorPickerContextValue | null>(null);

function useColorPickerContext(consumerName: string) {
	const context = useContext(ColorPickerContext);
	if (!context) {
		throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
	}
	return context;
}

export {
	ColorPickerContext,
	type ColorPickerContextValue,
	type Direction,
	MAX_RECENT_COLORS,
	recordRecentColor,
	type Store,
	StoreContext,
	type StoreState,
	useColorPickerContext,
	useRecentColors,
	useStore,
	useStoreContext,
};
