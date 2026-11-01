// Paint the active interface's own colour theme (`colorTheme` on a Marketplace
// interface contribution) as a temporary override of the user's preset.
//
// The override lives in `lib/themes/theme-override.ts`; every place that picks
// the preset to paint (`hooks/useThemePreset.ts`) consults it. Leaving the
// interface, or turning off "Use interface color themes", clears it and the
// user's own preset comes back. Sandboxed Companion app UIs follow on their own:
// they mirror the inline theme tokens on <html>.

import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import { useEffect } from "react";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePluginContributionsQuery } from "@/src/hooks/usePluginContributions.ts";
import { reapplyActivePreset } from "@/src/hooks/useThemePreset.ts";
import { type ProductMode, useProductMode } from "@/src/lib/product-mode.ts";
import {
	getThemeOverride,
	INTERFACE_COLOR_THEMES_DEFAULT,
	INTERFACE_COLOR_THEMES_KEY,
	setThemeOverride,
	type ThemeOverride,
} from "@/src/lib/themes/theme-override.ts";
import { useActiveInterface, useInterfaceStore } from "./interface-store.ts";
import { BUILTIN_INTERFACES, isPendingInterface } from "./registry.ts";

const NO_INTERFACES: InterfaceDescriptor[] = [];

export interface ThemeOverrideInput {
	/** The interface the shell renders right now. */
	active: InterfaceDescriptor;
	/** The override in effect now (the persisted one on a cold start). */
	current: ThemeOverride | null;
	/** The user's "Use interface color themes" switch. */
	enabled: boolean;
	/** True while Marketplace interfaces are still loading. */
	loading: boolean;
	/** The product tier: only the workspace ("os") renders Marketplace interfaces. */
	productMode: ProductMode;
	/** The remembered workspace interface id. */
	workspaceInterfaceId: string;
}

/**
 * Whether the override may still belong to the interface about to render: the
 * workspace tier is showing and its remembered interface is the override's
 * owner, a Marketplace id rather than a built-in.
 */
function mayBeAboutToRender(
	current: ThemeOverride,
	productMode: ProductMode,
	workspaceInterfaceId: string
): boolean {
	return (
		productMode === "os" &&
		workspaceInterfaceId === current.source &&
		!BUILTIN_INTERFACES.some((entry) => entry.id === current.source)
	);
}

/**
 * The override the active interface asks for. While contributions are still
 * loading the active descriptor is only a stand-in, so the current override is
 * kept when it can still belong to the interface about to render: a cold start
 * then paints the interface's colours straight away instead of flashing the
 * user's preset first. Booting into Bot, Console or another interface drops it.
 */
export function nextThemeOverride({
	active,
	current,
	enabled,
	loading,
	productMode,
	workspaceInterfaceId,
}: ThemeOverrideInput): ThemeOverride | null {
	if (!enabled) {
		return null;
	}
	if (loading || isPendingInterface(active)) {
		return current &&
			mayBeAboutToRender(current, productMode, workspaceInterfaceId)
			? current
			: null;
	}
	if (!(active.colorTheme && active.plugin)) {
		return null;
	}
	return {
		source: active.id,
		plugin: active.plugin,
		label: active.label,
		...active.colorTheme,
	};
}

/**
 * Keep the theme override in step with the active interface. Mount once in the
 * shell layout, next to the plugin theme sync. Unmounting it (onboarding,
 * sign-out, any screen outside the layout) ends the override, so the user's
 * own preset paints wherever the interface is not shown.
 */
export function useInterfaceColorThemeSync(): void {
	// The query, not the store mirror: the mirror lands one effect later, and
	// resolving against its empty list would clear the override for a frame.
	const { data, isPending } = usePluginContributionsQuery();
	const active = useActiveInterface(data?.interfaces ?? NO_INTERFACES);
	const [enabled] = usePersistedToggle(
		INTERFACE_COLOR_THEMES_KEY,
		INTERFACE_COLOR_THEMES_DEFAULT
	);
	const productMode = useProductMode();
	const workspaceInterfaceId = useInterfaceStore(
		(state) => state.workspaceInterfaceId
	);
	const loading = data === undefined && isPending;

	useEffect(() => {
		const next = nextThemeOverride({
			active,
			current: getThemeOverride(),
			enabled,
			loading,
			productMode,
			workspaceInterfaceId,
		});
		if (setThemeOverride(next)) {
			reapplyActivePreset();
		}
	}, [active, enabled, loading, productMode, workspaceInterfaceId]);

	useEffect(
		() => () => {
			if (setThemeOverride(null)) {
				reapplyActivePreset();
			}
		},
		[]
	);
}
