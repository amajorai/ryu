/**
 * Which desktop the visitor is on: OS and CPU architecture detection, plus the
 * labels the download surfaces print for them.
 *
 * Split out of `download-assets.ts` (which re-exports everything here) so the
 * release-resolution module stays within the repository's file-size limits.
 * Module evaluation stays browser-agnostic: every detector falls back to the
 * macOS / Intel defaults on the server.
 */

export type DownloadOS = "macos" | "windows" | "linux";
export type DownloadArch = "intel" | "arm";

/** Detect the visitor's desktop platform without making module evaluation browser-only. */
export function detectDownloadOS(): DownloadOS {
	if (globalThis.window === undefined) {
		return "macos";
	}
	const userAgent = window.navigator.userAgent.toLowerCase();
	const platform = window.navigator.platform.toLowerCase();
	if (
		userAgent.includes("mac") ||
		userAgent.includes("iphone") ||
		userAgent.includes("ipad") ||
		platform.includes("mac")
	) {
		return "macos";
	}
	if (userAgent.includes("win") || platform.includes("win")) {
		return "windows";
	}
	if (
		userAgent.includes("linux") ||
		platform.includes("linux") ||
		userAgent.includes("x11")
	) {
		return "linux";
	}
	return "macos";
}

/** Resolve architecture signals, preferring the browser's explicit CPU value. */
export function classifyDownloadArch(
	userAgent: string,
	highEntropyArchitecture?: string | null
): DownloadArch {
	const architecture = highEntropyArchitecture?.toLowerCase() ?? "";
	const normalizedUserAgent = userAgent.toLowerCase();
	return architecture.includes("arm") ||
		normalizedUserAgent.includes("arm") ||
		normalizedUserAgent.includes("aarch64")
		? "arm"
		: "intel";
}

/** Detect the visitor's processor architecture, defaulting to Intel-compatible builds. */
export function detectDownloadArch(): DownloadArch {
	if (globalThis.window === undefined) {
		return "intel";
	}
	return classifyDownloadArch(window.navigator.userAgent);
}

/**
 * Chromium deliberately reports Apple-silicon Macs as `MacIntel` in its normal
 * user agent. Use its high-entropy architecture signal when available, while
 * retaining the synchronous detector as the Safari/Firefox fallback.
 */
export async function detectDownloadArchAsync(): Promise<DownloadArch> {
	if (globalThis.window === undefined) {
		return "intel";
	}
	// SAFETY: The receiver is the native browser Navigator. The Chromium-only entropy API is optional and invoked with optional chaining; missing or rejected support follows the existing fallback.
	const browserNavigator = window.navigator as Navigator & {
		userAgentData?: {
			getHighEntropyValues?: (
				hints: string[]
			) => Promise<{ architecture?: string }>;
		};
	};
	try {
		const values = await browserNavigator.userAgentData?.getHighEntropyValues?.(
			["architecture"]
		);
		return classifyDownloadArch(
			browserNavigator.userAgent,
			values?.architecture
		);
	} catch {
		return detectDownloadArch();
	}
}

export function archLabel(platformId: string, arch: DownloadArch) {
	if (platformId === "macos") {
		return arch === "arm" ? "Apple Silicon" : "Intel";
	}
	return arch === "arm" ? "ARM64" : "x64";
}

export function osName(os: DownloadOS) {
	if (os === "windows") {
		return "Windows";
	}
	if (os === "linux") {
		return "Linux";
	}
	return "macOS";
}
