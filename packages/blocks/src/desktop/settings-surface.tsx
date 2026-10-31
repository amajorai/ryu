"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * What a flush settings block sits on.
 *
 * - `plain` (default): nothing; the desktop Settings dialog and Gateway panes
 *   set rows straight on the pane.
 * - `card`: each `SettingsGroup` and `SettingsCard` paints a rounded card
 *   behind its flush rows, for a page frame (the web organization console)
 *   whose sections would otherwise float on the page background. Rows,
 *   hairlines and descriptions are unchanged; only the surface is added.
 *
 * An explicit `appearance="grouped"` still wins over the surface.
 */
export type SettingsSurface = "plain" | "card";

const SettingsSurfaceContext = createContext<SettingsSurface>("plain");

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
