import { ConsentHostContext } from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DEFAULT_THEME_MODE } from "@ryu/ui/theme/prefs.ts";
import { ThemeProvider } from "next-themes";
import { BotTerminologyProvider } from "../components/BotTerminologyProvider.tsx";
import { chatConsentHost } from "../components/chat/consent/chat-consent-host.ts";
import { MediaPipWindow } from "../components/media/MediaPip.tsx";
import { auxWindowTitle, useAuxWindowTitle } from "./use-aux-window-title.ts";

/** The picture-in-picture media window. It only exists as a Tauri window, so
 *  it always gets the desktop's in-chat consent host. */
export default function MediaPipOverlay() {
	const tl = useLiteralMessages();
	useAuxWindowTitle(auxWindowTitle(tl, tl("Live Media")));
	return (
		<ConsentHostContext.Provider value={chatConsentHost}>
			<ThemeProvider
				attribute="class"
				defaultTheme={DEFAULT_THEME_MODE}
				enableSystem
				themes={["light", "dark", "system"]}
			>
				<BotTerminologyProvider>
					<MediaPipWindow />
				</BotTerminologyProvider>
			</ThemeProvider>
		</ConsentHostContext.Provider>
	);
}
