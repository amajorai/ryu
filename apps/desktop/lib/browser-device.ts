import { z } from "zod";

export type BrowserFamily = "chrome" | "edge" | "firefox" | "safari" | "other";

export interface BrowserDevice {
	browser: BrowserFamily;
	isComputer: boolean;
	isIpad: boolean;
	isMobile: boolean;
}

export interface BrowserDeviceSignals {
	maxTouchPoints: number;
	platform: string;
	userAgent: string;
	userAgentDataMobile?: boolean;
}

/**
 * Classify a browser for presentation-only onboarding decisions.
 *
 * iPadOS Safari can advertise a desktop Mac user agent, so the touch-point
 * signal is part of the iPad check. This must never be used as an auth or
 * capability boundary: a user can always choose the hosted browser path.
 */
export function classifyBrowserDevice(
	signals: BrowserDeviceSignals
): BrowserDevice {
	const userAgent = signals.userAgent.toLowerCase();
	const platform = signals.platform.toLowerCase();
	const isIpad =
		userAgent.includes("ipad") ||
		(platform === "macintel" && signals.maxTouchPoints > 1);
	const isMobile =
		Boolean(signals.userAgentDataMobile) ||
		isIpad ||
		/iPhone|iPod|Android|Mobile/i.test(signals.userAgent);

	let browser: BrowserFamily = "other";
	if (userAgent.includes("edg/")) {
		browser = "edge";
	} else if (userAgent.includes("firefox/") || userAgent.includes("fxios/")) {
		browser = "firefox";
	} else if (
		userAgent.includes("chrome/") ||
		userAgent.includes("chromium/") ||
		userAgent.includes("crios/")
	) {
		browser = "chrome";
	} else if (userAgent.includes("safari/") && !userAgent.includes("chrome/")) {
		browser = "safari";
	}

	return {
		browser,
		isComputer: !isMobile,
		isIpad,
		isMobile,
	};
}

export function detectBrowserDevice(): BrowserDevice {
	if (!globalThis.navigator) {
		return {
			browser: "other",
			isComputer: true,
			isIpad: false,
			isMobile: false,
		};
	}

	const { userAgentData } = z
		.object({
			userAgentData: z
				.object({ mobile: z.boolean().optional() })
				.optional()
				.catch(undefined),
		})
		.parse(navigator);
	return classifyBrowserDevice({
		maxTouchPoints: navigator.maxTouchPoints,
		platform: navigator.platform,
		userAgent: navigator.userAgent,
		userAgentDataMobile: userAgentData?.mobile,
	});
}
