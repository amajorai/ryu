"use client";
import {
	BANNER_COLORS,
	BANNER_DIRECTIONS,
	type BannerColor,
	isBannerPresetId,
} from "@ryu/ui/components/banner-presets";
import type { GradientDirection } from "@ryu/ui/components/dither-kit/gradient";
import {
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The user's banner override for one agent. Every field is optional: with none
 * of them set the deterministic per-name default applies, so every agent has a
 * sensible banner without anyone ever opening this dialog.
 */
export interface AgentBannerPrefs {
	/** A palette name, or a HUE (0–360) for a custom colour. `DitherGradient`'s
	 *  `from` is `DitherColor | number`, and the gradient presets take a base hue,
	 *  so one field drives both styles. */
	color?: BannerColor;
	direction?: GradientDirection;
	/** A `BANNER_PRESETS` id. Absent = the dither default. */
	preset?: string;
	/** Safe Marketplace choice rendered through a built-in host adapter. */
	wallpaper?: MarketplaceWallpaperSelection;
}

export interface AgentBannerPreferenceStore {
	get: (agentId: string) => Promise<string | null>;
	set: (agentId: string, value: string) => Promise<void>;
}

const bannerPrefsKey = (agent: string) => `ryu:agent-banner:${agent}`;

function isBannerColor<T>(value: T): value is T & BannerColor {
	return (
		(isNativeNumber(value) &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 360) ||
		(isNativeText(value) && BANNER_COLORS.some((color) => color === value))
	);
}

function isBannerDirection<T>(value: T): value is T & GradientDirection {
	return BANNER_DIRECTIONS.some((direction) => direction === value);
}

/** Native JSON object domain from the complete shared raw tree owner. Arrays
 * and primitives still take the existing empty-preference fallback. */
type StoredBannerJsonObject = Exclude<
	Extract<AppResponseValue, object>,
	readonly AppResponseValue[]
>;

function isRecord(value: AppResponseValue): value is StoredBannerJsonObject {
	return isNativeObjectLike(value) && !Array.isArray(value);
}

function parseAgentBannerPrefs(value: AppResponseValue): AgentBannerPrefs {
	if (!isRecord(value)) {
		return {};
	}
	const prefs: AgentBannerPrefs = {};
	if (isBannerColor(value.color)) {
		prefs.color = value.color;
	}
	if (isBannerDirection(value.direction)) {
		prefs.direction = value.direction;
	}
	if (isNativeText(value.preset) && isBannerPresetId(value.preset)) {
		prefs.preset = value.preset;
	}
	const wallpaper = parseMarketplaceWallpaperSelection(value.wallpaper);
	if (wallpaper) {
		prefs.wallpaper = wallpaper;
	}
	return prefs;
}

function readAgentBannerPrefs(raw: string | null): AgentBannerPrefs {
	if (!raw) {
		return {};
	}
	try {
		const parsed = appResponseValueSchema.parse(JSON.parse(raw));
		return parseAgentBannerPrefs(parsed);
	} catch {
		return {};
	}
}

/**
 * Read one agent's stored banner prefs, dropping any field this build cannot
 * paint.
 *
 * The dropping is load-bearing, not defensive dressing: a stale `color` string
 * that isn't a palette swatch reaches `fillOf` → `PALETTE[color].fill`, which
 * THROWS during canvas paint and takes the whole editor down on open. An unknown
 * `preset` id is the same bug class one layer up. Both fall back to the derived
 * default instead.
 */
export function loadAgentBannerPrefs(agent: string): AgentBannerPrefs {
	try {
		const raw = localStorage.getItem(bannerPrefsKey(agent));
		return readAgentBannerPrefs(raw);
	} catch {
		// Corrupt or unavailable storage must never break the editor.
		return {};
	}
}

export function saveAgentBannerPrefs(
	agent: string,
	prefs: AgentBannerPrefs
): void {
	try {
		localStorage.setItem(bannerPrefsKey(agent), JSON.stringify(prefs));
	} catch {
		// Non-fatal: the banner falls back to the derived default next load.
	}
}

/** The prefs for one agent, loaded once per name and written through on change.
 *  Instant-apply — there is no Save button, so the preview and the banner behind
 *  the dialog move together. */
export function useAgentBannerPrefs(
	agent: string,
	store?: AgentBannerPreferenceStore,
	legacyAgent = agent
) {
	const [prefs, setPrefs] = useState<AgentBannerPrefs>(() =>
		store ? {} : loadAgentBannerPrefs(agent)
	);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [loading, setLoading] = useState(Boolean(store));
	const prefsRef = useRef(prefs);

	useEffect(() => {
		let current = true;
		setLoading(Boolean(store));
		if (!store) {
			const next = loadAgentBannerPrefs(agent);
			prefsRef.current = next;
			setPrefs(next);
			setStorageError(null);
			setLoading(false);
			return () => {
				current = false;
			};
		}
		setStorageError(null);
		void (async () => {
			try {
				const raw = await store.get(agent);
				let next: AgentBannerPrefs;
				if (raw === null) {
					next = loadAgentBannerPrefs(legacyAgent);
					if (Object.keys(next).length > 0) {
						await store.set(agent, JSON.stringify(next));
					}
				} else {
					next = readAgentBannerPrefs(raw);
				}
				if (current) {
					prefsRef.current = next;
					setPrefs(next);
					setLoading(false);
				}
			} catch {
				if (current) {
					prefsRef.current = {};
					setPrefs({});
					setStorageError(
						"Agent banner preferences could not be read from this node."
					);
					setLoading(false);
				}
			}
		})();
		return () => {
			current = false;
		};
	}, [agent, legacyAgent, store]);

	const update = useCallback(
		async (next: AgentBannerPrefs): Promise<boolean> => {
			const merged = { ...prefsRef.current, ...next };
			if (Object.hasOwn(next, "wallpaper") && next.wallpaper === undefined) {
				merged.wallpaper = undefined;
			}
			try {
				if (store) {
					await store.set(agent, JSON.stringify(merged));
				} else {
					saveAgentBannerPrefs(agent, merged);
				}
				prefsRef.current = merged;
				setPrefs(merged);
				setStorageError(null);
				return true;
			} catch {
				setStorageError(
					"Agent banner preferences could not be saved to this node."
				);
				return false;
			}
		},
		[agent, store]
	);

	const reset = useCallback(async (): Promise<boolean> => {
		try {
			if (store) {
				await store.set(agent, "{}");
			} else {
				saveAgentBannerPrefs(agent, {});
			}
			prefsRef.current = {};
			setPrefs({});
			setStorageError(null);
			return true;
		} catch {
			setStorageError(
				"Agent banner preferences could not be saved to this node."
			);
			return false;
		}
	}, [agent, store]);

	return { error: storageError, loading, prefs, reset, update };
}
