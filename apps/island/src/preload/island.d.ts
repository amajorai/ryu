import type { IslandApi } from "../shared/ipc.ts";
import type { IslandLanguageApi } from "../shared/language-selection.ts";
import type { IslandSurfaceWindowApi } from "../shared/screen-surface.ts";

declare global {
	interface Window {
		island: IslandApi;
		/** Only in the Island window (`preload/index.ts`): save a language choice. */
		islandLanguage?: IslandLanguageApi;
		/** Only in the on-screen generative UI window (`preload/surface.ts`). */
		islandSurface: IslandSurfaceWindowApi;
	}
}
