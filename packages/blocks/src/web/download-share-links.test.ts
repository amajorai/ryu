import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	downloadPageUrl,
	emailShareUrl,
	isMobileVisitor,
	smsPlatformFor,
	smsShareUrl,
	telegramShareUrl,
	whatsappShareUrl,
} from "./download-share-links.ts";

const URL_UNDER_TEST = "https://ryuhq.com/download";
const TEXT = "Download Ryu on your computer:";

const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPAD_DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("downloadPageUrl", () => {
	test("joins the origin and the download path once", () => {
		expect(downloadPageUrl("https://ryuhq.com")).toBe(URL_UNDER_TEST);
		expect(downloadPageUrl("https://ryuhq.com/")).toBe(URL_UNDER_TEST);
	});
});

describe("share links", () => {
	test("WhatsApp carries the message and link as one encoded text", () => {
		expect(whatsappShareUrl(TEXT, URL_UNDER_TEST)).toBe(
			"https://wa.me/?text=Download%20Ryu%20on%20your%20computer%3A%20https%3A%2F%2Fryuhq.com%2Fdownload"
		);
	});

	test("Telegram keeps the link and caption in separate fields", () => {
		const href = new URL(telegramShareUrl(TEXT, URL_UNDER_TEST));
		expect(href.origin + href.pathname).toBe("https://t.me/share/url");
		expect(href.searchParams.get("url")).toBe(URL_UNDER_TEST);
		expect(href.searchParams.get("text")).toBe(TEXT);
	});

	test("SMS uses each platform's body separator", () => {
		const body =
			"Download%20Ryu%20on%20your%20computer%3A%20https%3A%2F%2Fryuhq.com%2Fdownload";
		expect(smsShareUrl(TEXT, URL_UNDER_TEST, "ios")).toBe(`sms:&body=${body}`);
		expect(smsShareUrl(TEXT, URL_UNDER_TEST, "android")).toBe(
			`sms:?body=${body}`
		);
		expect(smsShareUrl(TEXT, URL_UNDER_TEST, "unknown")).toBe(
			`sms:?&body=${body}`
		);
	});

	test("email has no recipient and never writes spaces as +", () => {
		const href = emailShareUrl("Download Ryu", TEXT, URL_UNDER_TEST);
		expect(href).toBe(
			"mailto:?subject=Download%20Ryu&body=Download%20Ryu%20on%20your%20computer%3A%20https%3A%2F%2Fryuhq.com%2Fdownload"
		);
		expect(href).not.toContain("+");
	});

	test("an & in the shared link cannot end the body early", () => {
		const href = smsShareUrl(TEXT, "https://ryuhq.com/download?a=1&b=2", "ios");
		expect(href).toContain("a%3D1%26b%3D2");
		expect(href.match(/&/gu)).toHaveLength(1);
	});
});

describe("smsPlatformFor", () => {
	test("reads iOS, Android and iPadOS (a Mac with touch)", () => {
		expect(smsPlatformFor({ userAgent: IPHONE_UA })).toBe("ios");
		expect(smsPlatformFor({ userAgent: ANDROID_UA })).toBe("android");
		expect(
			smsPlatformFor({
				maxTouchPoints: 5,
				platform: "MacIntel",
				userAgent: IPAD_DESKTOP_UA,
			})
		).toBe("ios");
		expect(smsPlatformFor({ userAgent: WINDOWS_UA })).toBe("unknown");
	});
});

describe("isMobileVisitor", () => {
	const noMedia = () => false;

	test("phones and tablets by user agent", () => {
		expect(isMobileVisitor({ userAgent: IPHONE_UA })).toBe(true);
		expect(isMobileVisitor({ userAgent: ANDROID_UA })).toBe(true);
		expect(
			isMobileVisitor({
				maxTouchPoints: 5,
				platform: "MacIntel",
				userAgent: IPAD_DESKTOP_UA,
			})
		).toBe(true);
	});

	test("a phone user agent wins over userAgentData.mobile === false", () => {
		expect(
			isMobileVisitor({ userAgent: ANDROID_UA, userAgentDataMobile: false })
		).toBe(true);
	});

	test("userAgentData.mobile alone is enough", () => {
		expect(
			isMobileVisitor({ userAgent: WINDOWS_UA, userAgentDataMobile: true })
		).toBe(true);
	});

	test("a narrow touch-first window counts; a desktop never does", () => {
		const coarse = (query: string) => query === "(pointer: coarse)";
		expect(
			isMobileVisitor({
				matchesMedia: coarse,
				maxTouchPoints: 5,
				userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
				viewportWidth: 400,
			})
		).toBe(true);
		expect(
			isMobileVisitor({
				matchesMedia: noMedia,
				maxTouchPoints: 0,
				userAgent: WINDOWS_UA,
				viewportWidth: 400,
			})
		).toBe(false);
		expect(
			isMobileVisitor({
				matchesMedia: coarse,
				maxTouchPoints: 10,
				userAgent: WINDOWS_UA,
				viewportWidth: 1920,
			})
		).toBe(false);
		expect(
			isMobileVisitor({
				maxTouchPoints: 0,
				platform: "MacIntel",
				userAgent: IPAD_DESKTOP_UA,
			})
		).toBe(false);
	});
});

describe("phone switch wiring", () => {
	const hookSource = readFileSync(
		new URL("./send-download-link.tsx", import.meta.url),
		"utf8"
	);
	const menuSource = readFileSync(
		new URL("./download-menu.tsx", import.meta.url),
		"utf8"
	);

	test("the drawer chunk loads on demand and falls back to the download page", () => {
		expect(hookSource).not.toMatch(
			/^\s*import\s(?!type)[^;]*from\s+["']\.\/download-send-drawer\.tsx["']/m
		);
		expect(hookSource).toContain('import("./download-send-drawer.tsx")');
		expect(hookSource).toContain("() => ({ default: OpenDownloadPage })");
	});

	test("detection runs after mount so the server HTML stays the desktop markup", () => {
		expect(hookSource).toMatch(
			/const \[mobile, setMobile\] = useState\(false\);\s*useEffect\(\(\) => \{\s*setMobile\(isMobileVisitor\(readMobileVisitorEnv\(\)\)\);/
		);
		expect(hookSource).toMatch(
			/if \(!mobile\) \{\s*return;\s*\}\s*event\.preventDefault\(\);/
		);
	});

	test("both segments of the download control hand off on a phone", () => {
		expect(menuSource).toContain("onClick={sendLink.intercept}");
		expect(menuSource).toContain("showMenu && sendLink.mobile");
		expect(menuSource).toContain("showMenu && !sendLink.mobile");
	});
});
