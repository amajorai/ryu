import { createContext, useContext } from "react";

/**
 * The settings every kit 3D game shares (`KitGameParams` in
 * `@ryuhq/protocol/interfaces`), as the kit's act pieces read them. The host
 * provides them from the interface's live params, so a game needs no code
 * of its own for them.
 */
export interface GameKitSettings {
	/** `minimal`: station boards keep limit and cue lines only. */
	overlayDensity: "full" | "minimal";
	/** False hides villagers' work bubbles (asks, alarms and results stay). */
	workBubbles: boolean;
}

export const GAME_KIT_DEFAULTS: GameKitSettings = {
	overlayDensity: "full",
	workBubbles: true,
};

/** The kit game settings for the interface being drawn. */
export const GameKitSettingsContext =
	createContext<GameKitSettings>(GAME_KIT_DEFAULTS);

/** The kit game settings in effect (the defaults outside a host). */
export function useGameKitSettings(): GameKitSettings {
	return useContext(GameKitSettingsContext);
}

/**
 * The app's own motion setting: true when the user turned animations off
 * in the host (Settings → Appearance → Motion). `useReducedMotion` treats it
 * like the system's reduce-motion preference.
 */
export const HostReducedMotionContext = createContext(false);
