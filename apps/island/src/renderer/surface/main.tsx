// Entry for the on-screen generative UI window (see main/screen-surface.ts).

import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IslandI18nProvider } from "../components/IslandI18nProvider.tsx";
import "../index.css";
import { ScreenSurfaceApp } from "./ScreenSurfaceApp.tsx";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root element #root not found");
}

// Same locale, language pack, and text direction as the Island: the provider
// sets `<html lang/dir>` and localizes the screen's chrome.
createRoot(container).render(
	<StrictMode>
		<IslandI18nProvider languagePacks={window.islandSurface.languagePacks}>
			<ScreenSurfaceApp />
		</IslandI18nProvider>
	</StrictMode>
);
