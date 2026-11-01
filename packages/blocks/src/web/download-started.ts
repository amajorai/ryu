// The "an installer download just started" signal. Download controls announce
// it the moment a click hands the visitor a desktop installer; the
// post-download guide (download-guide-overlay.tsx) listens and explains where
// the file went and how to install it.
//
// A window event rather than React context: the controls live in page headers,
// heroes and lazily loaded menus that share no provider, and the listener must
// not pull the guide's code into any of them.

import type { DownloadArch, DownloadOS } from "./download-platform.ts";

export const DOWNLOAD_STARTED_EVENT = "ryu:download-started";

export interface DownloadStartedDetail {
	arch: DownloadArch | null;
	/** The installer's file name (e.g. `Ryu_1.2.3_aarch64.dmg`), when known. */
	assetName: string | null;
	/** The URL that was downloaded, so the guide can offer to try again. */
	href: string;
	os: DownloadOS;
}

/** Tell any listening guide that an installer download started. No-op during SSR. */
export function announceDownloadStarted(detail: DownloadStartedDetail): void {
	if (globalThis.window === undefined) {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<DownloadStartedDetail>(DOWNLOAD_STARTED_EVENT, {
			detail: { ...detail },
		})
	);
}

function isDownloadStartedDetail(
	value: unknown
): value is DownloadStartedDetail {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<DownloadStartedDetail>;
	return (
		(candidate.os === "macos" ||
			candidate.os === "windows" ||
			candidate.os === "linux") &&
		typeof candidate.href === "string"
	);
}

/**
 * Listen for announced downloads. Returns the unsubscribe function; during SSR
 * nothing is subscribed and the returned function does nothing.
 */
export function subscribeDownloadStarted(
	listener: (detail: DownloadStartedDetail) => void
): () => void {
	if (globalThis.window === undefined) {
		return () => undefined;
	}
	const handle = (event: Event) => {
		const detail = (event as CustomEvent<unknown>).detail;
		if (isDownloadStartedDetail(detail)) {
			listener({
				os: detail.os,
				arch: detail.arch ?? null,
				assetName: detail.assetName ?? null,
				href: detail.href,
			});
		}
	};
	window.addEventListener(DOWNLOAD_STARTED_EVENT, handle);
	return () => window.removeEventListener(DOWNLOAD_STARTED_EVENT, handle);
}
