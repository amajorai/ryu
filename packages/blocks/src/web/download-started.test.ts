import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	announceDownloadStarted,
	DOWNLOAD_STARTED_EVENT,
	type DownloadStartedDetail,
	subscribeDownloadStarted,
} from "./download-started.ts";

const DETAIL: DownloadStartedDetail = {
	os: "macos",
	arch: "arm",
	assetName: "Ryu_1.0.0_aarch64.dmg",
	href: "https://example.test/Ryu_1.0.0_aarch64.dmg",
};

// Exercised before the DOM is registered below: the server has no window.
const ssrHadWindow = globalThis.window !== undefined;
let ssrListenerCalls = 0;
announceDownloadStarted(DETAIL);
const ssrUnsubscribe = subscribeDownloadStarted(() => {
	ssrListenerCalls += 1;
});

GlobalRegistrator.register({ url: "https://ryu.test/" });
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

describe("download-started", () => {
	test("announce and subscribe are no-ops during SSR", () => {
		expect(ssrHadWindow).toBe(false);
		ssrUnsubscribe();
		announceDownloadStarted(DETAIL);
		expect(ssrListenerCalls).toBe(0);
	});

	test("a subscriber receives each announced download", () => {
		const received: DownloadStartedDetail[] = [];
		const unsubscribe = subscribeDownloadStarted((detail) => {
			received.push(detail);
		});
		announceDownloadStarted(DETAIL);
		announceDownloadStarted({ ...DETAIL, os: "windows", arch: null });
		unsubscribe();
		expect(received).toEqual([
			DETAIL,
			{ ...DETAIL, os: "windows", arch: null },
		]);
	});

	test("unsubscribing stops delivery", () => {
		const received: DownloadStartedDetail[] = [];
		const unsubscribe = subscribeDownloadStarted((detail) => {
			received.push(detail);
		});
		unsubscribe();
		announceDownloadStarted(DETAIL);
		expect(received).toEqual([]);
	});

	test("the announced detail is a copy the caller cannot mutate afterwards", () => {
		const received: DownloadStartedDetail[] = [];
		const unsubscribe = subscribeDownloadStarted((detail) => {
			received.push(detail);
		});
		const detail = { ...DETAIL };
		announceDownloadStarted(detail);
		detail.assetName = "changed";
		unsubscribe();
		expect(received[0]?.assetName).toBe("Ryu_1.0.0_aarch64.dmg");
	});

	test("malformed events on the same name are ignored", () => {
		const received: DownloadStartedDetail[] = [];
		const unsubscribe = subscribeDownloadStarted((detail) => {
			received.push(detail);
		});
		window.dispatchEvent(new Event(DOWNLOAD_STARTED_EVENT));
		window.dispatchEvent(
			new CustomEvent(DOWNLOAD_STARTED_EVENT, {
				detail: { os: "android", href: "x" },
			})
		);
		window.dispatchEvent(
			new CustomEvent(DOWNLOAD_STARTED_EVENT, {
				detail: { os: "linux", href: "https://x.test/a.deb" },
			})
		);
		unsubscribe();
		expect(received).toEqual([
			{
				os: "linux",
				arch: null,
				assetName: null,
				href: "https://x.test/a.deb",
			},
		]);
	});
});
