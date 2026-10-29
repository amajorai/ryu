/** Shared presentation guard for connected-app suggestions cached by a host or app. */
export interface CachedNotification {
	body?: string | null;
	id: string;
	node_id?: string | null;
	title: string;
	workflow_run_id?: string | null;
}

const PRIVATE_TITLE = "Private connected-app activity";
const PRIVATE_BODY =
	"A connected-app event was hidden during Streaming. Review it in the source app when you’re ready.";

export function redactConnectSuggestionNotifications<
	T extends CachedNotification,
>(notifications: T[], streamingActive: boolean): T[] {
	if (!streamingActive) {
		return notifications;
	}
	return notifications.map((notification) =>
		notification.id.startsWith("ntf_connect_")
			? {
					...notification,
					body: PRIVATE_BODY,
					title: PRIVATE_TITLE,
					workflow_run_id: null,
					node_id: null,
				}
			: notification
	);
}

export function redactConnectSuggestionEvent<
	T extends {
		notification_id?: string | null;
		title: string;
		body?: string | null;
	},
>(event: T, streamingActive: boolean): T {
	if (!(streamingActive && event.notification_id?.startsWith("ntf_connect_"))) {
		return event;
	}
	return { ...event, body: PRIVATE_BODY, title: PRIVATE_TITLE };
}

export interface CompanionPrivacyBridge {
	getSnapshot: () => boolean;
	subscribe: (onChange: () => void) => () => void;
}

declare global {
	interface Window {
		__ryuStreamingPrivacy?: CompanionPrivacyBridge;
	}
}

function privacyBridge(): CompanionPrivacyBridge | undefined {
	return globalThis.window === undefined
		? undefined
		: window.__ryuStreamingPrivacy;
}

/** Missing host state is private, including an app's first render before handshake. */
export function getCompanionStreamingPrivacy(): boolean {
	return privacyBridge()?.getSnapshot() !== false;
}

export function subscribeCompanionStreamingPrivacy(
	onChange: () => void
): () => void {
	return privacyBridge()?.subscribe(onChange) ?? (() => undefined);
}

/** Installed before app code in both document formats; NONCE belongs to the host bootstrap. */
export const COMPANION_PRIVACY_STATE_SCRIPT = `
var streamingPrivacyActive = true;
var privacyListeners = new Set();
window.__ryuStreamingPrivacy = Object.freeze({
  getSnapshot: function () { return streamingPrivacyActive; },
  subscribe: function (onChange) {
    privacyListeners.add(onChange);
    return function () { privacyListeners.delete(onChange); };
  }
});
window.addEventListener("message", function (ev) {
  var msg = ev.data;
  if (ev.source !== window.parent || !msg || msg.kind !== "ryu-plugin-privacy" || msg.nonce !== NONCE || typeof msg.streamingActive !== "boolean") return;
  if (streamingPrivacyActive === msg.streamingActive) return;
  streamingPrivacyActive = msg.streamingActive;
  privacyListeners.forEach(function (listener) { listener(); });
});
`;
