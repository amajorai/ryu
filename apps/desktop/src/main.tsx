import { installHorizontalWheelScrolling } from "@ryu/ui/lib/horizontal-wheel-scroll";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { LanguagePackBridge } from "./components/LanguagePackBridge.tsx";
// Imported here rather than via `@import` in index.css: Tailwind v4 inlines an
// `@import`ed package's CSS without rebasing its relative url()s, which left the
// woff2 files unemitted and the fonts 404ing in release builds. See index.css.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./index.css";
import { initDialogOverlayBlur } from "./hooks/useDialogOverlayBlur.ts";
import { initPopupOverlayBlur } from "./hooks/usePopupOverlayBlur.ts";
import { installConsoleCapture } from "./lib/console-buffer.ts";
import { queryClient } from "./lib/query-client.ts";

// Dev-only: capture console output so the crash screen can offer a one-click
// "Copy console" action. No-op in production builds.
installConsoleCapture();

// Before the first render, not in an App effect: the CSS base state is the
// blurred backdrop (it has to be, for apps/web), while the desktop default is
// OFF. Running this a frame later would flash a dimmed, blurred backdrop on any
// dialog that mounts with the app — see @ryu/ui hooks/use-dialog-overlay-blur.ts.
initDialogOverlayBlur();
initPopupOverlayBlur();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

installHorizontalWheelScrolling(document);

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<LanguagePackBridge>
				<App hostSurface="desktop" />
			</LanguagePackBridge>
		</QueryClientProvider>
	</StrictMode>
);
