// What a visitor sees right after an installer download starts: where their
// browser put the file, and how to open and install it on their system.
//
// Pure data (no JSX) so the copy and the detection can be unit tested and
// shared by the post-download overlay and the download page's install section.
//
// The desktop builds are not Developer ID notarized on macOS or code-signed on
// Windows yet (`.github/workflows/release.yml`), so the first launch needs one
// extra confirmation from Gatekeeper or SmartScreen. The steps say so plainly
// instead of leaving the visitor stuck at a warning dialog.

import { translate as tl } from "@ryu/i18n/lite";
import type { DownloadOS } from "./download-platform.ts";

export type GuideBrowser =
	| "brave"
	| "chrome"
	| "edge"
	| "firefox"
	| "opera"
	| "safari"
	| "other";

export type InstallerFormat =
	| "appimage"
	| "deb"
	| "dmg"
	| "exe"
	| "msi"
	| "rpm";

const EDGE_UA_RE = /edg(?:e|a|ios)?\//i;
const OPERA_UA_RE = /\b(?:opr|opera)\//i;
const FIREFOX_UA_RE = /\b(?:firefox|fxios)\//i;
const CHROME_UA_RE = /\b(?:chrome|chromium|crios)\//i;
const SAFARI_UA_RE = /\bversion\/[\d.]+.*\bsafari\//i;

/**
 * Classify a user agent into the browser whose download UI we describe.
 * Order matters: Edge and Opera carry "Chrome" in their UA, and Chrome carries
 * "Safari". Brave reports a plain Chrome UA, so it is only recognised through
 * `navigator.brave` (pass `isBrave`).
 */
export function classifyGuideBrowser(
	userAgent: string,
	isBrave = false
): GuideBrowser {
	if (EDGE_UA_RE.test(userAgent)) {
		return "edge";
	}
	if (OPERA_UA_RE.test(userAgent)) {
		return "opera";
	}
	if (FIREFOX_UA_RE.test(userAgent)) {
		return "firefox";
	}
	if (CHROME_UA_RE.test(userAgent)) {
		return isBrave ? "brave" : "chrome";
	}
	if (SAFARI_UA_RE.test(userAgent)) {
		return "safari";
	}
	return "other";
}

/** Detect the current browser; "other" during SSR. */
export function detectGuideBrowser(): GuideBrowser {
	if (globalThis.window === undefined) {
		return "other";
	}
	const nav = window.navigator as Navigator & { brave?: unknown };
	return classifyGuideBrowser(nav.userAgent ?? "", nav.brave !== undefined);
}

export const GUIDE_BROWSER_NAMES: Record<GuideBrowser, string> = {
	brave: "Brave",
	chrome: "Chrome",
	edge: "Edge",
	firefox: "Firefox",
	opera: "Opera",
	safari: "Safari",
	other: "your browser",
};

export interface BrowserDownloadHint {
	browser: GuideBrowser;
	/** Short name for headings ("Chrome", "your browser"). */
	name: string;
	/** Whether the download control sits in the toolbar's top-right corner, so an arrow can point at it. */
	pointsTopRight: boolean;
	/** Keyboard shortcut that opens the browser's downloads list, if any. */
	shortcut: string | null;
	/** Where the finished download shows up, as one sentence. */
	where: string;
}

function chromiumShortcut(os: DownloadOS): string {
	return os === "macos" ? "⌥⌘L" : "Ctrl+J";
}

function firefoxShortcut(os: DownloadOS): string {
	if (os === "macos") {
		return "⌘J";
	}
	return os === "windows" ? "Ctrl+J" : "Ctrl+Shift+Y";
}

/** Where the browser shows the finished download, for the detected OS. */
export function browserDownloadHint(
	browser: GuideBrowser,
	os: DownloadOS
): BrowserDownloadHint {
	const name = GUIDE_BROWSER_NAMES[browser];
	switch (browser) {
		case "chrome":
		case "brave":
			return {
				browser,
				name,
				where:
					"Click the downloads icon in the top-right corner of the toolbar, then click the Ryu installer.",
				shortcut: chromiumShortcut(os),
				pointsTopRight: true,
			};
		case "edge":
			return {
				browser,
				name,
				where:
					"Open the Downloads panel in the top-right corner of the toolbar, then click Open file under the Ryu installer.",
				shortcut: os === "macos" ? null : "Ctrl+J",
				pointsTopRight: true,
			};
		case "opera":
			return {
				browser,
				name,
				where:
					"Click the downloads icon in the top-right corner, then click the Ryu installer.",
				shortcut: os === "macos" ? null : "Ctrl+J",
				pointsTopRight: true,
			};
		case "firefox":
			return {
				browser,
				name,
				where:
					"Click the downloads arrow in the top-right corner of the toolbar, then click the Ryu installer.",
				// Firefox: ⌘J on macOS, Ctrl+J on Windows, Ctrl+Shift+Y on Linux
				// (⌘⇧J is its Browser Console).
				shortcut: firefoxShortcut(os),
				pointsTopRight: true,
			};
		case "safari":
			return {
				browser,
				name,
				where:
					"Click the downloads button in the top-right corner of the Safari toolbar, then double-click the Ryu installer.",
				shortcut: "⌥⌘L",
				pointsTopRight: true,
			};
		default:
			return {
				browser,
				name,
				where:
					"Open your Downloads folder, or your browser's downloads list, and open the Ryu installer.",
				shortcut: null,
				pointsTopRight: false,
			};
	}
}

const FORMAT_EXTENSIONS: [RegExp, InstallerFormat][] = [
	[/\.dmg$/i, "dmg"],
	[/\.exe$/i, "exe"],
	[/\.msi$/i, "msi"],
	[/\.deb$/i, "deb"],
	[/\.rpm$/i, "rpm"],
	[/\.appimage$/i, "appimage"],
];

/** The installer format a file name carries, or null for anything else. */
export function installerFormatOf(fileName: string): InstallerFormat | null {
	for (const [pattern, format] of FORMAT_EXTENSIONS) {
		if (pattern.test(fileName)) {
			return format;
		}
	}
	return null;
}

/** The format each OS's primary download resolves to (`PLATFORM_ASSET_PATTERNS` order). */
export const DEFAULT_INSTALLER_FORMAT: Record<DownloadOS, InstallerFormat> = {
	macos: "dmg",
	windows: "exe",
	linux: "appimage",
};

export const INSTALLER_FORMAT_LABELS: Record<InstallerFormat, string> = {
	appimage: "AppImage",
	deb: ".deb (Debian, Ubuntu)",
	dmg: ".dmg disk image",
	exe: "Windows installer (.exe)",
	msi: "Windows installer (.msi)",
	rpm: ".rpm (Fedora, openSUSE)",
};

export interface InstallStep {
	/** A terminal command to copy, when the step is one. */
	command?: string;
	description: string;
	title: string;
}

export interface InstallGuide {
	format: InstallerFormat;
	os: DownloadOS;
	steps: InstallStep[];
	/** What to do when the system blocks the first launch, if it might. */
	troubleshooting: InstallStep | null;
}

const MACOS_GATEKEEPER: InstallStep = {
	title: "If macOS says it can't verify Ryu",
	description:
		"Ryu isn't notarized by Apple yet, so the first launch needs one confirmation. Click Done, open System Settings → Privacy & Security, scroll down, click Open Anyway next to Ryu, and confirm.",
};

const WINDOWS_SMARTSCREEN: InstallStep = {
	title: "If Windows protected your PC",
	description:
		"The installer isn't code-signed yet, so SmartScreen may warn you. Click More info, then Run anyway.",
};

/**
 * Quote a file name for a shell command only when it needs it. Single quotes
 * keep `$`, backticks and `"` literal; an embedded `'` is closed, escaped and
 * reopened.
 */
function shellPath(fileName: string): string {
	if (/^[\w.+-]+$/.test(fileName)) {
		return `./${fileName}`;
	}
	return `'./${fileName.replaceAll("'", "'\\''")}'`;
}

/**
 * The file to name in a command: the real one when known, otherwise a shell
 * glob that matches the versioned release asset (`Ryu_<version>_amd64.deb`).
 * Globs are emitted unquoted so the shell expands them.
 */
function commandPath(fileName: string | undefined, glob: string): string {
	return fileName ? shellPath(fileName) : glob;
}

/**
 * Step-by-step install instructions for a downloaded installer. `fileName`
 * is used verbatim in commands when known; otherwise a glob matching the
 * versioned release asset is shown.
 */
export function installGuide(
	os: DownloadOS,
	format: InstallerFormat = DEFAULT_INSTALLER_FORMAT[os],
	fileName?: string
): InstallGuide {
	switch (format) {
		case "dmg":
			return {
				format,
				os,
				steps: [
					{
						title: "Open the disk image",
						description: fileName
							? tl("Open {fileName} from your downloads.", { fileName })
							: tl("Open the Ryu .dmg file from your downloads."),
					},
					{
						title: "Drag Ryu to Applications",
						description:
							"In the window that opens, drag the Ryu icon onto the Applications folder.",
					},
					{
						title: "Launch Ryu",
						description:
							"Open Ryu from Applications or Spotlight (⌘ Space, then type Ryu). You can eject the disk image afterwards.",
					},
				],
				troubleshooting: MACOS_GATEKEEPER,
			};
		case "exe":
		case "msi":
			return {
				format,
				os,
				steps: [
					{
						title: "Run the installer",
						description: fileName
							? tl("Open {fileName} from your downloads.", { fileName })
							: tl("Open the Ryu installer from your downloads."),
					},
					{
						title: "Follow the setup",
						// Tauri's NSIS setup installs per user; its WiX .msi installs
						// per machine under Program Files and asks for admin approval.
						description:
							format === "msi"
								? "Accept the prompts and approve the administrator request. Ryu installs for all users and adds a Start menu shortcut."
								: "Accept the prompts. Ryu installs for your user account and adds a Start menu shortcut.",
					},
					{
						title: "Launch Ryu",
						description:
							"Open Ryu from the Start menu. It keeps itself up to date from then on.",
					},
				],
				troubleshooting: WINDOWS_SMARTSCREEN,
			};
		case "deb": {
			const path = commandPath(fileName, "./Ryu_*_amd64.deb");
			return {
				format,
				os,
				steps: [
					{
						title: "Open a terminal in your downloads",
						description: "Change to the folder the .deb was saved in.",
						command: "cd ~/Downloads",
					},
					{
						title: "Install the package",
						description:
							"apt resolves the dependencies. You can also double-click the file to install it with your software center.",
						command: `sudo apt install ${path}`,
					},
					{
						title: "Launch Ryu",
						description: "Open Ryu from your applications menu.",
					},
				],
				troubleshooting: null,
			};
		}
		case "rpm": {
			const path = commandPath(fileName, "./Ryu-*.x86_64.rpm");
			return {
				format,
				os,
				steps: [
					{
						title: "Open a terminal in your downloads",
						description: "Change to the folder the .rpm was saved in.",
						command: "cd ~/Downloads",
					},
					{
						title: "Install the package",
						description:
							"On openSUSE, use sudo zypper install with the same file instead.",
						command: `sudo dnf install ${path}`,
					},
					{
						title: "Launch Ryu",
						description: "Open Ryu from your applications menu.",
					},
				],
				troubleshooting: null,
			};
		}
		default: {
			const path = commandPath(fileName, "./Ryu_*_amd64.AppImage");
			return {
				format: "appimage",
				os,
				steps: [
					{
						title: "Make it executable",
						description:
							"In a terminal, or right-click the file → Properties → Allow executing as a program.",
						command: `cd ~/Downloads && chmod +x ${path}`,
					},
					{
						title: "Run Ryu",
						description:
							"Double-click the AppImage, or start it from the terminal. No install step is needed.",
						command: path,
					},
					{
						title: "If it doesn't start",
						description:
							"Some distributions need FUSE 2 for AppImages, for example sudo apt install libfuse2 on Ubuntu.",
					},
				],
				troubleshooting: null,
			};
		}
	}
}
