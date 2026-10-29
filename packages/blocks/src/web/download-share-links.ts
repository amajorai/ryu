/**
 * Ryu installs on a computer, so a phone visitor who taps Download is offered a
 * way to get the download page onto their computer instead of an installer
 * their phone cannot run. These are the pure pieces of that: where the link
 * goes, the share links that carry it, and whether this visitor is on a phone.
 *
 * Every builder uses `encodeURIComponent`, never `URLSearchParams`: the latter
 * writes spaces as `+`, which mail and SMS apps show literally.
 */

export const DOWNLOAD_PAGE_PATH = "/download";

/** The share title and the line that goes in front of the link. */
export const DOWNLOAD_SHARE_TITLE = "Download Ryu";
export const DOWNLOAD_SHARE_TEXT = "Download Ryu on your computer:";

/** The absolute download page URL a phone visitor sends to themselves. */
export function downloadPageUrl(origin: string): string {
	return `${origin.replace(/\/+$/u, "")}${DOWNLOAD_PAGE_PATH}`;
}

function messageWithLink(text: string, url: string): string {
	return `${text} ${url}`;
}

/** WhatsApp's universal share link: opens the app with the message prefilled. */
export function whatsappShareUrl(text: string, url: string): string {
	return `https://wa.me/?text=${encodeURIComponent(messageWithLink(text, url))}`;
}

/** Telegram's share link: the link and its caption are separate fields. */
export function telegramShareUrl(text: string, url: string): string {
	return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

export type SmsPlatform = "android" | "ios" | "unknown";

/**
 * The `body` separator for an `sms:` link with no recipient. iOS reads
 * `sms:&body=`, Android reads `sms:?body=`, and `sms:?&body=` is the form both
 * accept when the platform is not known.
 */
const SMS_BODY_SEPARATOR: Record<SmsPlatform, string> = {
	android: "?",
	ios: "&",
	unknown: "?&",
};

export function smsShareUrl(
	text: string,
	url: string,
	platform: SmsPlatform
): string {
	return `sms:${SMS_BODY_SEPARATOR[platform]}body=${encodeURIComponent(messageWithLink(text, url))}`;
}

/** A `mailto:` with no recipient, so the visitor picks their own address. */
export function emailShareUrl(subject: string, text: string, url: string) {
	return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(messageWithLink(text, url))}`;
}

const IOS_USER_AGENT = /iPhone|iPad|iPod/u;
const ANDROID_USER_AGENT = /Android/u;
const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobi/u;

/** Narrower than this, a touch-first device is treated as a phone or tablet. */
const MOBILE_MAX_WIDTH = 1024;

export interface MobileVisitorEnv {
	/** `matchMedia(query).matches`, injected so the check runs in tests. */
	matchesMedia?: (query: string) => boolean;
	maxTouchPoints?: number;
	platform?: string;
	userAgent?: string;
	userAgentDataMobile?: boolean;
	viewportWidth?: number;
}

/** Which `sms:` form this device reads. iPadOS reports a Mac with touch. */
export function smsPlatformFor(env: MobileVisitorEnv): SmsPlatform {
	const userAgent = env.userAgent ?? "";
	if (ANDROID_USER_AGENT.test(userAgent)) {
		return "android";
	}
	if (IOS_USER_AGENT.test(userAgent) || isTouchMac(env)) {
		return "ios";
	}
	return "unknown";
}

function isTouchMac(env: MobileVisitorEnv): boolean {
	return (
		/Mac/u.test(env.platform ?? env.userAgent ?? "") &&
		(env.maxTouchPoints ?? 0) > 1
	);
}

/**
 * Whether this visitor is on a phone or tablet. Any one signal is enough: a
 * browser that reports `userAgentData.mobile === false` while sending a phone
 * user agent (an emulated phone, or a desktop-mode request) is still treated
 * as the phone its user agent names.
 */
export function isMobileVisitor(env: MobileVisitorEnv): boolean {
	if (env.userAgentDataMobile === true) {
		return true;
	}
	if (MOBILE_USER_AGENT.test(env.userAgent ?? "") || isTouchMac(env)) {
		return true;
	}
	const coarsePointer = env.matchesMedia?.("(pointer: coarse)") ?? false;
	const narrow =
		(env.viewportWidth ?? Number.POSITIVE_INFINITY) < MOBILE_MAX_WIDTH;
	return coarsePointer && narrow && (env.maxTouchPoints ?? 0) > 0;
}

/** Reads the detection signals off the live browser (client only). */
export function readMobileVisitorEnv(): MobileVisitorEnv {
	const nav = navigator as Navigator & {
		userAgentData?: { mobile?: boolean };
	};
	return {
		matchesMedia: (query) =>
			typeof window.matchMedia === "function" &&
			window.matchMedia(query).matches,
		maxTouchPoints: nav.maxTouchPoints,
		platform: nav.platform,
		userAgent: nav.userAgent,
		userAgentDataMobile: nav.userAgentData?.mobile,
		viewportWidth: window.innerWidth,
	};
}
