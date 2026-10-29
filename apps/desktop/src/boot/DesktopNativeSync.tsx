import { useEffect, useRef } from "react";
import { withTauri } from "@/src/lib/tauri-ready.ts";
import { useAcpKeepAwake } from "../hooks/useAcpKeepAwake.ts";
import { useActiveInterfaceFromStore } from "../interfaces/interface-store.ts";
import { useBuildProfile } from "../lib/build-profile.ts";
import { isRyuStandaloneApp, STANDALONE_APP_NAME } from "../lib/product.ts";
import { useProductMode } from "../lib/product-mode.ts";
import { useReleaseChannel } from "../lib/release-channel.ts";
import { resolveDesktopWindowTitle } from "../lib/window-title.ts";
import { HOSTED_STANDALONE_APP_ID } from "./window-identity.ts";

/** Syncs the native window/taskbar label with the active product and release channel. */
function WindowTitleManager() {
	if (HOSTED_STANDALONE_APP_ID) {
		return null;
	}
	const { dev } = useBuildProfile();
	const [channel] = useReleaseChannel();
	const productMode = useProductMode();
	// Channels, Feed, a world, or a Marketplace interface: "Ryu Channels".
	const activeInterface = useActiveInterfaceFromStore();
	const standaloneApp = isRyuStandaloneApp();
	const title = resolveDesktopWindowTitle({
		channel,
		dev,
		interfaceLabel: activeInterface.label,
		mode: productMode,
		standaloneApp,
		standaloneAppName: STANDALONE_APP_NAME,
	});
	const latestTitle = useRef(title);
	const titleRequest = useRef(0);
	latestTitle.current = title;

	useEffect(() => {
		const request = ++titleRequest.current;

		// A slow cold-start title write must not overwrite a newer Bot/Console
		// selection. If an older native write completes after a newer one, correct
		// it immediately with the latest title.
		withTauri(async () => {
			if (request !== titleRequest.current) {
				return;
			}
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			const currentWindow = getCurrentWindow();
			await currentWindow.setTitle(title);
			if (request !== titleRequest.current) {
				await currentWindow.setTitle(latestTitle.current);
			}
		}).catch(() => {
			// Setting the window title is cosmetic — never worth surfacing.
		});
	}, [title]);

	return null;
}

/**
 * Native-window chores of the desktop main window: the title and the ACP
 * keep-awake assertion. Both are inert outside Tauri (the browser hosts shim
 * the title write and the keep-awake poll waits for the bridge), so only the
 * desktop surface mounts this, after its code has loaded.
 */
export default function DesktopNativeSync() {
	useAcpKeepAwake();
	return <WindowTitleManager />;
}
