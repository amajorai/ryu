interface AskResult {
	answer: string;
	model: string;
	ok: boolean;
}
type MessageListener = (message: { type: string }) => void;
type SettingsListener = (
	changes: { ryu_browser_settings: { newValue: typeof settings } },
	area: string
) => void;
const settingsListeners = new Set<SettingsListener>();
const messageListeners = new Set<MessageListener>();
const counts = { pushes: 0, saves: 0, health: 0, asks: 0, extracts: 0 };
const settings = {
	islandBridgeEnabled: true,
	autoSaveEnabled: true,
	aiToolbarEnabled: true,
	copilotEnabled: true,
	selectionButtonEnabled: true,
	saveSpaceId: null,
};
let releaseSettings: (() => void) | undefined;
const waitingSettings = new Promise<void>((resolve) => {
	releaseSettings = resolve;
});
const asks: ((value: AskResult) => void)[] = [];
function publish() {
	for (const [key, value] of Object.entries(counts)) {
		document.documentElement.dataset[key] = String(value);
	}
	document.documentElement.dataset.settingsListeners = String(
		settingsListeners.size
	);
	document.documentElement.dataset.messageListeners = String(
		messageListeners.size
	);
}
export function extracted() {
	counts.extracts++;
	publish();
}
export function release() {
	releaseSettings?.();
}
export function resolveAsk() {
	asks.shift()?.({
		ok: true,
		answer: "Current content context ready.",
		model: "Fixture",
	});
}
export function askPage() {
	for (const listener of messageListeners) {
		listener({ type: "ryu:ask-page" });
	}
}
export function settingsChanged() {
	for (const listener of settingsListeners) {
		listener({ ryu_browser_settings: { newValue: settings } }, "local");
	}
}
export const browser = {
	runtime: {
		id: "performance-extension",
		onMessage: {
			addListener: (listener: MessageListener) => {
				messageListeners.add(listener);
				publish();
			},
			removeListener: (listener: MessageListener) => {
				messageListeners.delete(listener);
				publish();
			},
		},
		sendMessage: async (message: { type: string; defaultMessage?: string }) => {
			if (message.type === "ryu:i18n-translate") {
				return { ok: true, value: message.defaultMessage };
			}
			if (message.type === "ryu:connection-status") {
				counts.health++;
				publish();
				return { ok: true, reachable: true };
			}
			if (message.type === "ryu:push-context") {
				counts.pushes++;
				publish();
				return { ok: true };
			}
			if (message.type === "ryu:save-page") {
				counts.saves++;
				publish();
				return { ok: true, spaceName: "Saved pages" };
			}
			if (message.type === "ryu:ask") {
				counts.asks++;
				publish();
				return new Promise<AskResult>((resolve) => asks.push(resolve));
			}
			return { ok: true };
		},
	},
	storage: {
		local: {
			get: async () => {
				if (location.search.includes("late")) {
					await waitingSettings;
				}
				return { ryu_browser_settings: settings };
			},
			set: async () => undefined,
		},
		onChanged: {
			addListener: (listener: SettingsListener) => {
				settingsListeners.add(listener);
				publish();
			},
			removeListener: (listener: SettingsListener) => {
				settingsListeners.delete(listener);
				publish();
			},
		},
	},
};
