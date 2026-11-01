"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * What a flush settings block sits on.
 *
 * - `card` (default): each `SettingsGroup` and `SettingsCard` paints a rounded
 *   grouped card behind its rows, as in iOS/macOS Settings. Rows, hairlines and
 *   descriptions are unchanged; only the surface is added. Every settings
 *   surface (the desktop Settings dialog, Gateway panes, web account and
 *   organization settings) uses it.
 * - `plain`: no surface, for a block that is already inside a card (a carded
 *   `SettingsGroup` sets it for its own children so cards never nest) or a
 *   caller that draws its own frame.
 *
 * An explicit `appearance="grouped"` still wins over the surface.
 */
export type SettingsSurface = "plain" | "card";

const SettingsSurfaceContext = createContext<SettingsSurface>("card");

export function SettingsSurfaceProvider({
	children,
	surface,
}: {
	children: ReactNode;
	surface: SettingsSurface;
}) {
	return (
		<SettingsSurfaceContext.Provider value={surface}>
			{children}
		</SettingsSurfaceContext.Provider>
	);
}

export function useSettingsSurface(): SettingsSurface {
	return useContext(SettingsSurfaceContext);
}

/** The card a flush block paints on a `card` surface. */
export const SETTINGS_SURFACE_CARD = "rounded-xl bg-grouped-card";
