import { describe, expect, test } from "bun:test";
import {
	browserDownloadHint,
	classifyGuideBrowser,
	DEFAULT_INSTALLER_FORMAT,
	detectGuideBrowser,
	GUIDE_BROWSER_NAMES,
	type GuideBrowser,
	INSTALLER_FORMAT_LABELS,
	type InstallerFormat,
	installerFormatOf,
	installGuide,
} from "./download-guide.ts";

const UA = {
	chromeMac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	chromeWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	chromeLinux:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	chromeIos:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
	chromium:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/129.0.0.0 Safari/537.36",
	edgeWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
	edgeLegacy:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582",
	edgeAndroid:
		"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.2849.64",
	edgeIos:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/130.2849.56 Mobile/15E148 Safari/605.1.15",
	operaWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/115.0.0.0",
	operaPresto:
		"Opera/9.80 (Windows NT 6.1; U; en) Presto/2.12.388 Version/12.16",
	firefoxMac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0",
	firefoxLinux:
		"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
	firefoxIos:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
	safariMac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
	safariIos:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
	safariIpad:
		"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	iosWebView:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
	curl: "curl/8.7.1",
} as const;

describe("classifyGuideBrowser", () => {
	const cases: [string, GuideBrowser][] = [
		[UA.chromeMac, "chrome"],
		[UA.chromeWindows, "chrome"],
		[UA.chromeLinux, "chrome"],
		[UA.chromeIos, "chrome"],
		[UA.chromium, "chrome"],
		[UA.edgeWindows, "edge"],
		[UA.edgeLegacy, "edge"],
		[UA.edgeAndroid, "edge"],
		[UA.edgeIos, "edge"],
		[UA.operaWindows, "opera"],
		[UA.operaPresto, "opera"],
		[UA.firefoxMac, "firefox"],
		[UA.firefoxLinux, "firefox"],
		[UA.firefoxIos, "firefox"],
		[UA.safariMac, "safari"],
		[UA.safariIos, "safari"],
		[UA.safariIpad, "safari"],
		[UA.iosWebView, "other"],
		[UA.curl, "other"],
		["", "other"],
	];
	for (const [userAgent, expected] of cases) {
		test(`${expected} <- ${userAgent.slice(0, 60) || "(empty)"}`, () => {
			expect(classifyGuideBrowser(userAgent)).toBe(expected);
		});
	}

	test("Brave reports a Chrome UA and is only recognised through the flag", () => {
		expect(classifyGuideBrowser(UA.chromeMac, true)).toBe("brave");
		expect(classifyGuideBrowser(UA.chromeWindows, true)).toBe("brave");
	});

	test("the Brave flag never relabels a non-Chromium browser", () => {
		expect(classifyGuideBrowser(UA.firefoxMac, true)).toBe("firefox");
		expect(classifyGuideBrowser(UA.safariMac, true)).toBe("safari");
		expect(classifyGuideBrowser(UA.edgeWindows, true)).toBe("edge");
	});

	test("detectGuideBrowser falls back to other without a window (SSR)", () => {
		expect(globalThis.window).toBeUndefined();
		expect(detectGuideBrowser()).toBe("other");
	});
});

describe("browserDownloadHint", () => {
	test("Chrome and Brave point top right with the Chromium shortcut per OS", () => {
		for (const browser of ["chrome", "brave"] as const) {
			const mac = browserDownloadHint(browser, "macos");
			expect(mac.pointsTopRight).toBe(true);
			expect(mac.shortcut).toBe("⌥⌘L");
			expect(mac.name).toBe(GUIDE_BROWSER_NAMES[browser]);
			expect(mac.where).toContain("top-right");
			expect(browserDownloadHint(browser, "windows").shortcut).toBe("Ctrl+J");
			expect(browserDownloadHint(browser, "linux").shortcut).toBe("Ctrl+J");
		}
	});

	test("Edge and Opera have no documented macOS shortcut", () => {
		for (const browser of ["edge", "opera"] as const) {
			expect(browserDownloadHint(browser, "macos").shortcut).toBeNull();
			expect(browserDownloadHint(browser, "windows").shortcut).toBe("Ctrl+J");
			expect(browserDownloadHint(browser, "macos").pointsTopRight).toBe(true);
		}
		expect(browserDownloadHint("edge", "windows").where).toContain("Open file");
	});

	test("Firefox uses its own shortcuts per OS", () => {
		expect(browserDownloadHint("firefox", "macos").shortcut).toBe("⌘J");
		expect(browserDownloadHint("firefox", "windows").shortcut).toBe("Ctrl+J");
		expect(browserDownloadHint("firefox", "linux").shortcut).toBe(
			"Ctrl+Shift+Y"
		);
		expect(browserDownloadHint("firefox", "linux").pointsTopRight).toBe(true);
	});

	test("Safari points at its toolbar button", () => {
		const hint = browserDownloadHint("safari", "macos");
		expect(hint).toMatchObject({
			browser: "safari",
			name: "Safari",
			shortcut: "⌥⌘L",
			pointsTopRight: true,
		});
		expect(hint.where).toContain("Safari toolbar");
	});

	test("an unknown browser gets generic advice and no arrow", () => {
		const hint = browserDownloadHint("other", "windows");
		expect(hint).toMatchObject({
			name: "your browser",
			shortcut: null,
			pointsTopRight: false,
		});
		expect(hint.where).toContain("Downloads folder");
	});
});

describe("installerFormatOf", () => {
	const cases: [string, InstallerFormat | null][] = [
		["Ryu_1.2.3_aarch64.dmg", "dmg"],
		["Ryu_1.2.3_x64-setup.exe", "exe"],
		["Ryu_1.2.3_x64_en-US.msi", "msi"],
		["Ryu_1.2.3_amd64.deb", "deb"],
		["Ryu-1.2.3-1.x86_64.rpm", "rpm"],
		["Ryu_1.2.3_amd64.AppImage", "appimage"],
		["RYU.DMG", "dmg"],
		["ryu.appimage", "appimage"],
		["Ryu_1.2.3_aarch64.app.tar.gz", null],
		["Ryu.dmg.sig", null],
		["latest.json", null],
		["", null],
	];
	for (const [fileName, expected] of cases) {
		test(`${fileName || "(empty)"} -> ${expected}`, () => {
			expect(installerFormatOf(fileName)).toBe(expected);
		});
	}
});

describe("installer format tables", () => {
	test("each OS defaults to the format its primary download ships", () => {
		expect(DEFAULT_INSTALLER_FORMAT).toEqual({
			macos: "dmg",
			windows: "exe",
			linux: "appimage",
		});
	});

	test("every format has a label", () => {
		for (const format of [
			"appimage",
			"deb",
			"dmg",
			"exe",
			"msi",
			"rpm",
		] as const) {
			expect(INSTALLER_FORMAT_LABELS[format].length).toBeGreaterThan(0);
		}
	});
});

describe("installGuide", () => {
	test("defaults to the OS's primary format", () => {
		expect(installGuide("macos").format).toBe("dmg");
		expect(installGuide("windows").format).toBe("exe");
		expect(installGuide("linux").format).toBe("appimage");
	});

	test("dmg: three steps naming the file, with the Gatekeeper fallback", () => {
		const guide = installGuide("macos", "dmg", "Ryu_1.2.3_aarch64.dmg");
		expect(guide.steps).toHaveLength(3);
		expect(guide.steps[0]?.description).toContain("Ryu_1.2.3_aarch64.dmg");
		expect(guide.steps[1]?.title).toBe("Drag Ryu to Applications");
		expect(guide.steps.some((step) => step.command)).toBe(false);
		expect(guide.troubleshooting?.description).toContain("Open Anyway");
		expect(installGuide("macos", "dmg").steps[0]?.description).toContain(
			"the Ryu .dmg file"
		);
	});

	test("exe and msi: SmartScreen fallback and no commands", () => {
		for (const format of ["exe", "msi"] as const) {
			const guide = installGuide("windows", format, `Ryu-setup.${format}`);
			expect(guide.format).toBe(format);
			expect(guide.steps).toHaveLength(3);
			expect(guide.steps[0]?.description).toContain(`Ryu-setup.${format}`);
			expect(guide.troubleshooting?.description).toContain("Run anyway");
			expect(guide.steps.some((step) => step.command)).toBe(false);
		}
	});

	test("exe installs per user; msi installs per machine with admin approval", () => {
		const exe = installGuide("windows", "exe").steps[1]?.description;
		const msi = installGuide("windows", "msi").steps[1]?.description;
		expect(exe).toContain("your user account");
		expect(msi).toContain("all users");
		expect(msi).toContain("administrator");
		expect(msi).not.toContain("your user account");
	});

	test("deb: apt install of the downloaded file", () => {
		const guide = installGuide("linux", "deb", "Ryu_1.2.3_amd64.deb");
		expect(guide.steps.map((step) => step.command)).toEqual([
			"cd ~/Downloads",
			"sudo apt install ./Ryu_1.2.3_amd64.deb",
			undefined,
		]);
		expect(guide.troubleshooting).toBeNull();
		expect(installGuide("linux", "deb").steps[1]?.command).toBe(
			"sudo apt install ./Ryu_*_amd64.deb"
		);
	});

	test("rpm: dnf install of the downloaded file", () => {
		const guide = installGuide("linux", "rpm", "Ryu-1.2.3-1.x86_64.rpm");
		expect(guide.steps[1]?.command).toBe(
			"sudo dnf install ./Ryu-1.2.3-1.x86_64.rpm"
		);
		expect(guide.steps[1]?.description).toContain("zypper");
		expect(installGuide("linux", "rpm").steps[1]?.command).toBe(
			"sudo dnf install ./Ryu-*.x86_64.rpm"
		);
	});

	test("AppImage: chmod then run, with the FUSE note", () => {
		const guide = installGuide("linux", "appimage", "Ryu_1.2.3_amd64.AppImage");
		expect(guide.steps.map((step) => step.command)).toEqual([
			"cd ~/Downloads && chmod +x ./Ryu_1.2.3_amd64.AppImage",
			"./Ryu_1.2.3_amd64.AppImage",
			undefined,
		]);
		expect(guide.steps[2]?.description).toContain("libfuse2");
		expect(installGuide("linux", "appimage").steps[1]?.command).toBe(
			"./Ryu_*_amd64.AppImage"
		);
	});

	test("file names with spaces or shell metacharacters are single-quoted", () => {
		expect(
			installGuide("linux", "appimage", "Ryu (1).AppImage").steps[0]?.command
		).toBe("cd ~/Downloads && chmod +x './Ryu (1).AppImage'");
		expect(
			installGuide("linux", "deb", "Ryu $HOME.deb").steps[1]?.command
		).toBe("sudo apt install './Ryu $HOME.deb'");
		expect(installGuide("linux", "rpm", "it's.rpm").steps[1]?.command).toBe(
			"sudo dnf install './it'\\''s.rpm'"
		);
	});
});
