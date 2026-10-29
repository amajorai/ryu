/* @jsxImportSource @opentui/react */

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import {
	detectColorScheme,
	ThemeProvider as OpenTuiThemeProvider,
} from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import {
	DEFAULT_THEME_PREFERENCE,
	loadThemePreference,
	noColorRequested,
	RYU_THEME_PRESETS,
	resolveThemePreference,
	saveThemePreference,
	serializeThemePreference,
	THEME_MODES,
	THEME_PRESET_IDS,
	type ThemeMode,
	type ThemePreference,
	type ThemePresetId,
} from "../core/themePreferences.ts";

export const TERMINAL_THEME_PREFERENCE_KEY = "terminal-theme";
/** The desktop's canonical preference is the fallback for a fresh terminal. */
export const DESKTOP_THEME_PREFERENCE_KEY = "theme";

interface PendingPreference {
	preference: ThemePreference;
	targetKey: string;
}

export interface TerminalThemeContextValue {
	/** Available mode values in picker order. */
	availableModes: typeof THEME_MODES;
	/** Available preset ids in picker order. */
	availablePresets: typeof THEME_PRESET_IDS;
	/** Alias for availableModes for consumers that use the shorter name. */
	modes: typeof THEME_MODES;
	/** The validated preference loaded for the active Core target. */
	preference: ThemePreference;
	/** Alias for availablePresets for consumers that use the shorter name. */
	presets: typeof THEME_PRESET_IDS;
	/** Restore the safe terminal theme default. */
	reset: () => void;
	/** Select the light, dark, or system mode. */
	setMode: (mode: ThemeMode) => void;
	/** Select a built-in terminal theme preset. */
	setPreset: (preset: ThemePresetId) => void;
}

const TerminalThemeContext = createContext<TerminalThemeContextValue | null>(
	null
);

function defaultPreference(): ThemePreference {
	return loadThemePreference(DEFAULT_THEME_PREFERENCE);
}

function targetKey(target: ApiTarget): string {
	return JSON.stringify([target.url, target.token]);
}

const preferencePayloadSchema = z.json();
const preferenceEnvelopeSchema = z.object({ value: preferencePayloadSchema });
function preferenceValue(
	response: Parameters<typeof preferencePayloadSchema.parse>[0]
): z.infer<typeof preferencePayloadSchema> {
	const payload = preferencePayloadSchema.parse(response);
	const envelope = preferenceEnvelopeSchema.safeParse(payload);
	return envelope.success ? envelope.data.value : payload;
}

function persistPreference(
	target: ApiTarget,
	preference: ThemePreference
): void {
	const value = serializeThemePreference(saveThemePreference(preference));
	void request(
		target,
		`/api/preferences/${TERMINAL_THEME_PREFERENCE_KEY}`,
		{
			body: { value },
			method: "PUT",
		},
		appResponseValueSchema
	).catch(() => undefined);
}

export interface TerminalThemeProviderProps {
	children: ReactNode;
}

export function TerminalThemeProvider({
	children,
}: TerminalThemeProviderProps) {
	const { target } = useCore();
	const activeTargetKey = targetKey(target);
	const [preference, setPreference] =
		useState<ThemePreference>(defaultPreference);
	const preferenceRef = useRef<ThemePreference>(preference);
	const preferenceTargetRef = useRef(activeTargetKey);
	const loadedTargetRef = useRef<string | null>(null);
	const pendingPreferenceRef = useRef<PendingPreference | null>(null);

	preferenceRef.current = preference;

	useEffect(() => {
		let cancelled = false;
		const pending = pendingPreferenceRef.current;

		loadedTargetRef.current = null;
		if (pending && pending.targetKey !== activeTargetKey) {
			pendingPreferenceRef.current = null;
		}

		if (preferenceTargetRef.current !== activeTargetKey) {
			const fallback = defaultPreference();
			preferenceTargetRef.current = activeTargetKey;
			preferenceRef.current = fallback;
			setPreference(fallback);
		}

		const finishLoad = (loaded: ThemePreference): void => {
			if (cancelled) {
				return;
			}

			const pendingForTarget = pendingPreferenceRef.current;
			const next =
				pendingForTarget?.targetKey === activeTargetKey
					? pendingForTarget.preference
					: loaded;
			preferenceTargetRef.current = activeTargetKey;
			preferenceRef.current = next;
			setPreference(next);
			loadedTargetRef.current = activeTargetKey;
			pendingPreferenceRef.current = null;

			if (pendingForTarget?.targetKey === activeTargetKey) {
				persistPreference(target, next);
			}
		};

		const load = async (): Promise<void> => {
			try {
				const response = await request(
					target,
					`/api/preferences/${TERMINAL_THEME_PREFERENCE_KEY}`,
					{},
					appResponseValueSchema
				);
				finishLoad(loadThemePreference(preferenceValue(response)));
				return;
			} catch {
				// A new terminal has no override yet. Follow the desktop's shared mode
				// preference before falling back to the terminal-safe default.
			}
			try {
				const response = await request(
					target,
					`/api/preferences/${DESKTOP_THEME_PREFERENCE_KEY}`,
					{},
					appResponseValueSchema
				);
				finishLoad(loadThemePreference(preferenceValue(response)));
			} catch {
				finishLoad(defaultPreference());
			}
		};

		void load();
		return () => {
			cancelled = true;
		};
	}, [activeTargetKey, target]);

	const applyUserPreference = useCallback(
		(nextValue: ThemePreference): void => {
			const base =
				preferenceTargetRef.current === activeTargetKey
					? preferenceRef.current
					: defaultPreference();
			const next = saveThemePreference(nextValue);
			if (next.mode === base.mode && next.preset === base.preset) {
				return;
			}

			preferenceTargetRef.current = activeTargetKey;
			preferenceRef.current = next;
			setPreference(next);

			if (loadedTargetRef.current === activeTargetKey) {
				persistPreference(target, next);
				return;
			}

			pendingPreferenceRef.current = {
				preference: next,
				targetKey: activeTargetKey,
			};
		},
		[activeTargetKey, target]
	);

	const setMode = useCallback(
		(mode: ThemeMode): void => {
			const base =
				preferenceTargetRef.current === activeTargetKey
					? preferenceRef.current
					: defaultPreference();
			applyUserPreference({ ...base, mode });
		},
		[activeTargetKey, applyUserPreference]
	);

	const setPreset = useCallback(
		(preset: ThemePresetId): void => {
			const base =
				preferenceTargetRef.current === activeTargetKey
					? preferenceRef.current
					: defaultPreference();
			applyUserPreference({ ...base, preset });
		},
		[activeTargetKey, applyUserPreference]
	);

	const reset = useCallback((): void => {
		applyUserPreference(defaultPreference());
	}, [applyUserPreference]);

	const theme = resolveThemePreference(
		preference,
		detectColorScheme(),
		noColorRequested()
	);
	const contextValue = useMemo<TerminalThemeContextValue>(
		() => ({
			availableModes: THEME_MODES,
			availablePresets: THEME_PRESET_IDS,
			modes: THEME_MODES,
			preference,
			presets: THEME_PRESET_IDS,
			reset,
			setMode,
			setPreset,
		}),
		[preference, reset, setMode, setPreset]
	);

	return (
		<TerminalThemeContext.Provider value={contextValue}>
			<OpenTuiThemeProvider theme={theme}>{children}</OpenTuiThemeProvider>
		</TerminalThemeContext.Provider>
	);
}

export function useTerminalTheme(): TerminalThemeContextValue {
	const context = useContext(TerminalThemeContext);
	if (!context) {
		throw new Error(
			"useTerminalTheme must be used within a TerminalThemeProvider"
		);
	}
	return context;
}

export { RYU_THEME_PRESETS };
