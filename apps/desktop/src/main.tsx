import { installHorizontalWheelScrolling } from "@ryu/ui/lib/horizontal-wheel-scroll.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
	getActiveCollaborationAccountId,
	onActiveTokenChange,
	vaultHydrated,
} from "@/lib/auth-client.ts";
import App from "./App.tsx";
import { AccountLocaleSync } from "./components/AccountLocaleSync.tsx";
import { LanguagePackBridge } from "./components/LanguagePackBridge.tsx";
import { UiLanguagePreferenceSync } from "./components/UiLanguagePreferenceSync.tsx";
// Imported here rather than via `@import` in index.css: Tailwind v4 inlines an
// `@import`ed package's CSS without rebasing its relative url()s, which left the
// woff2 files unemitted and the fonts 404ing in release builds. See index.css.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./index.css";
import { initDialogOverlayBlur } from "./hooks/useDialogOverlayBlur.ts";
import { initPopupOverlayBlur } from "./hooks/usePopupOverlayBlur.ts";
import { initializeProjectlessTaskFolder } from "./hooks/useProjectlessTaskFolder.ts";
import { initWindowTransparency } from "./hooks/useWindowTransparency.ts";
import { applyStartupInterfaceReset } from "./interfaces/interface-reset.ts";
import { saveAccountLocale } from "./lib/account-locale.ts";
import { installConsoleCapture } from "./lib/console-buffer.ts";
import { hydrateSealedLocalStorage } from "./lib/content-seal.ts";
import { queryClient } from "./lib/query-client.ts";
import { initializeTabTransfer } from "./lib/tab-transfer.ts";

// Dev-only: capture console output so the crash screen can offer a one-click
// "Copy console" action. No-op in production builds.
installConsoleCapture();

// Before the first render, not in an App effect: the CSS base state is the
// blurred backdrop (it has to be, for apps/web), while the desktop default is
// OFF. Running this a frame later would flash a dimmed, blurred backdrop on any
// dialog that mounts with the app — see @ryu/ui hooks/use-dialog-overlay-blur.ts.
initDialogOverlayBlur();
initPopupOverlayBlur();
initWindowTransparency();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

installHorizontalWheelScrolling(document);

const reactRoot = createRoot(root);
// The auth vault is sealed on disk and held in memory: the first render must
// wait for it, or synchronous token readers would see a signed-out session.
void Promise.all([
	initializeProjectlessTaskFolder(),
	initializeTabTransfer(),
	// `--reset-interface` / `RYU_RESET_INTERFACE=1`: boot into the default chat.
	applyStartupInterfaceReset().catch(() => false),
	vaultHydrated,
	// Sealed localStorage values (session tabs, layout, signed-in user, Prompt
	// Studio suites) are read synchronously by the first render.
	hydrateSealedLocalStorage(),
	// Collaborative snapshots are stored per account; set it before any
	// provider loads one. Loaded beside the entry chunk (it carries Yjs) so it
	// is fetched and parsed in parallel with the rest of startup.
	import("./lib/realtime/collaboration-account.ts")
		.then(({ followCollaborationAccount }) =>
			followCollaborationAccount({
				getActiveCollaborationAccountId,
				onActiveTokenChange,
				vaultHydrated,
			})
		)
		.catch(() => undefined),
]).then(() => {
	reactRoot.render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<LanguagePackBridge>
					{/* Lets the Island follow the language chosen here. */}
					<UiLanguagePreferenceSync />
					{/* Saves a language picked here on the cloud account for email. */}
					<AccountLocaleSync save={saveAccountLocale} />
					{/* The in-chat consent host is provided by the signed-in shell
					    and the overlay windows (src/boot), next to the chat. */}
					<App hostSurface="desktop" />
				</LanguagePackBridge>
			</QueryClientProvider>
		</StrictMode>
	);
});
