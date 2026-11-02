import type { LiteralMessage } from "@ryu/i18n/react";
import { useEffect } from "react";
import { withTauri } from "@/src/lib/tauri-ready.ts";

interface TitledWindow {
	setTitle(title: string): Promise<void>;
}

type WindowLoader = () => Promise<TitledWindow>;

async function loadCurrentWindow(): Promise<TitledWindow> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	return getCurrentWindow();
}

/**
 * "Ryu · Companion" in the reader's language; the product name is already
 * translated. Pass the reactive `tl` from `useLiteralMessages()` so the title
 * follows a language change (or a catalog that loads after the first render).
 */
export function auxWindowTitle(tl: LiteralMessage, product: string): string {
	return tl("Ryu · {product}", { product });
}

/**
 * Replace the English title the Rust builder gave an auxiliary window
 * (`aux_windows.rs`) with the localized one. The Rust literal stays the
 * fallback the OS shows before the webview mounts.
 */
export function applyAuxWindowTitle(
	title: string,
	loadWindow: WindowLoader = loadCurrentWindow
): Promise<void> {
	return withTauri(async () => {
		const currentWindow = await loadWindow();
		await currentWindow.setTitle(title);
	}).then(
		() => undefined,
		() => {
			// The window title is cosmetic; never surface a failed write.
		}
	);
}

/** Keep an auxiliary Tauri window's native title localized. */
export function useAuxWindowTitle(title: string): void {
	useEffect(() => {
		applyAuxWindowTitle(title);
	}, [title]);
}
