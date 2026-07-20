import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
// Imported here rather than via `@import` in index.css: Tailwind v4 inlines an
// `@import`ed package's CSS without rebasing its relative url()s, which left the
// woff2 files unemitted and the fonts 404ing in release builds. See index.css.
import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import "./index.css";
import { installConsoleCapture } from "./lib/console-buffer.ts";
import { queryClient } from "./lib/query-client.ts";

// Dev-only: capture console output so the crash screen can offer a one-click
// "Copy console" action. No-op in production builds.
installConsoleCapture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>
);
