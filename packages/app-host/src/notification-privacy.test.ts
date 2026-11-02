import { afterEach, describe, expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../i18n/src/active-locale.ts";
import {
	type CompanionPrivacyBridge,
	getCompanionStreamingPrivacy,
	redactConnectSuggestionEvent,
	redactConnectSuggestionNotifications,
} from "./notification-privacy.ts";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

const NONCE = "privacy-host-nonce";
const cached = [
	{
		id: "ntf_connect_private",
		title: "Confidential customer meeting",
		body: "Customer acquisition details",
		workflow_run_id: "private-run",
		node_id: "private-node",
	},
	{ id: "ntf_workflow", title: "Workflow complete", body: "Ordinary result" },
];

function bootPrivacy(html: string) {
	const listeners: Array<(event: { source: unknown; data: unknown }) => void> =
		[];
	const parent = { postMessage: () => undefined };
	let privacyBridge: CompanionPrivacyBridge | undefined;
	const frame = {
		parent,
		addEventListener: (
			kind: string,
			listener: (event: { source: unknown; data: unknown }) => void
		) => {
			if (kind === "message") {
				listeners.push(listener);
			}
		},
		get __ryuStreamingPrivacy(): CompanionPrivacyBridge | undefined {
			return privacyBridge;
		},
		set __ryuStreamingPrivacy(value: CompanionPrivacyBridge | undefined) {
			privacyBridge = value;
		},
	};
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	if (!script) {
		throw new Error("Missing first companion bootstrap");
	}
	runInNewContext(script, {
		window: frame,
		document: {
			getElementById: () => null,
			addEventListener: () => undefined,
			documentElement: { setAttribute: () => undefined },
		},
		setInterval: () => 1,
		setTimeout: () => 1,
		clearInterval: () => undefined,
	});
	const bridge = frame.__ryuStreamingPrivacy;
	if (!bridge) {
		throw new Error("Privacy bridge was not installed before app code");
	}
	return {
		bridge,
		post: (
			streamingActive: boolean | string,
			source: Partial<typeof parent> = parent,
			nonce = NONCE
		) => {
			for (const listener of listeners) {
				listener({
					source,
					data: { kind: "ryu-plugin-privacy", nonce, streamingActive },
				});
			}
		},
	};
}

describe("cached notification privacy", () => {
	it("fails closed without a host bridge", () => {
		expect(getCompanionStreamingPrivacy()).toBe(true);
	});

	for (const [format, document] of [
		["bundle", thirdPartyPluginSrcdoc(NONCE, "", "@ryu/approvals")],
		[
			"html",
			htmlCompanionSrcdoc(
				NONCE,
				"<!doctype html><html><head></head><body></body></html>",
				"@ryu/approvals"
			),
		],
	] as const) {
		it(`${format} bootstrap synchronously protects cached rows and authenticates state changes`, () => {
			const { bridge, post } = bootPrivacy(document);
			let notifications = redactConnectSuggestionNotifications(
				cached,
				bridge.getSnapshot()
			);
			let changes = 0;
			const unsubscribe = bridge.subscribe(() => {
				changes += 1;
				notifications = redactConnectSuggestionNotifications(
					cached,
					bridge.getSnapshot()
				);
			});
			expect(notifications[0]?.title).toBe("Private connected-app activity");
			expect(notifications[0]?.workflow_run_id).toBeNull();
			expect(notifications[0]?.node_id).toBeNull();
			expect(notifications[1]).toBe(cached[1]);
			post(false, {});
			post(false, undefined, "forged-nonce");
			post("false");
			expect(bridge.getSnapshot()).toBe(true);
			expect(changes).toBe(0);
			post(false);
			expect(notifications).toBe(cached);
			post(true);
			expect(changes).toBe(2);
			expect(notifications[0]?.body).not.toContain("Customer");
			expect(notifications[0]?.title).not.toContain("Confidential");
			expect(notifications[0]?.workflow_run_id).toBeNull();
			expect(notifications[0]?.node_id).toBeNull();
			post(true);
			expect(changes).toBe(2);
			unsubscribe();
			post(false);
			expect(changes).toBe(2);
			expect(cached[0]?.title).toBe("Confidential customer meeting");
		});
	}

	it("redacts Connect events while preserving ordinary events", () => {
		const event = {
			notification_id: "ntf_connect_private",
			title: "Secret",
			body: "Private details",
		};
		expect(redactConnectSuggestionEvent(event, true).title).toBe(
			"Private connected-app activity"
		);
		expect(redactConnectSuggestionEvent(event, false)).toBe(event);
		const ordinary = { ...event, notification_id: "ntf_workflow" };
		expect(redactConnectSuggestionEvent(ordinary, true)).toBe(ordinary);
	});
});

describe("the privacy placeholder follows the UI locale", () => {
	const german: Record<string, string> = {
		"Private connected-app activity": "Private Aktivität einer verbundenen App",
		"A connected-app event was hidden during Streaming. Review it in the source app when you’re ready.":
			"Ein Ereignis einer verbundenen App wurde während des Streamings ausgeblendet.",
	};
	const runtime: ActiveI18nRuntime = {
		direction: "ltr",
		locale: "de",
		translate: (_id, _values, fallback = "") => german[fallback] ?? fallback,
	};
	afterEach(() => unregisterActiveI18nRuntime(runtime));

	it("renders the cached-row and event placeholders in German", () => {
		registerActiveI18nRuntime(runtime);
		const [row] = redactConnectSuggestionNotifications(
			cached.slice(0, 1),
			true
		);
		expect(row?.title).toBe("Private Aktivität einer verbundenen App");
		expect(row?.body).toBe(
			"Ein Ereignis einer verbundenen App wurde während des Streamings ausgeblendet."
		);
		const event = redactConnectSuggestionEvent(
			{ notification_id: "ntf_connect_private", title: "Secret", body: "x" },
			true
		);
		expect(event.title).toBe("Private Aktivität einer verbundenen App");
	});
});
