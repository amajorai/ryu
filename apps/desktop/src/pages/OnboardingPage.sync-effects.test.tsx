import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type InstallerHandler = (event: { payload: unknown }) => void;
let installerHandler: InstallerHandler | null = null;

// Capture the installer-progress listener instead of reaching for Tauri.
const realTauriReady = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...realTauriReady,
	listenWhenReady: (event: string, handler: InstallerHandler) => {
		if (event === "installer-progress") {
			installerHandler = handler;
		}
		return Promise.resolve(() => {
			installerHandler = null;
		});
	},
}));

const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { useOnboardingSyncEffects } = await import(
	"./OnboardingPage.sync-effects.ts"
);

// Stub Japanese copy: the shipped catalog may not carry these keys yet.
const JA: Record<string, string> = {
	"Installing {componentLabel}…": "{componentLabel}をインストールしています…",
	"{componentLabel} installed": "{componentLabel}をインストールしました",
	"Starting Ryu Core…": "Ryu Core を起動しています…",
	"Ryu Core is healthy": "Ryu Core は正常です",
	"Installing bundled models, engines, and skills…":
		"同梱のモデル、エンジン、スキルをインストールしています…",
	"the model gateway": "モデルゲートウェイ",
};

const noop = () => undefined;

interface Probe {
	done: string[];
	live: { current: string | null };
}

function Harness({ probe }: { probe: Probe }) {
	const liveStatusRef = useRef<string | null>(null);
	probe.live = liveStatusRef;
	const lastExternalNodeState = useRef(null);
	const phaseRef = useRef("installing");
	useOnboardingSyncEffects({
		getActiveNode: noop,
		initialNodeOnboardingState: null,
		lastExternalNodeState,
		liveStatusRef,
		nodeOnboardingPending: false,
		nodeOnboardingStateAvailable: false,
		phaseRef,
		reportDone: (line: string) => {
			probe.done.push(line);
		},
		setCloudSelection: noop,
		setCompanyContext: noop,
		setCompanyKnowledgeEnabled: noop,
		setLocalSelection: noop,
		setNodeOnboardingState: noop,
		setNodeSetupError: noop,
		setNodeSetupKind: noop,
		setSubmitting: noop,
		setUserPersonalization: noop,
		updateLocalPercent: noop,
	} as unknown as Parameters<typeof useOnboardingSyncEffects>[0]);
	return null;
}

async function mountInJapanese(): Promise<{
	probe: Probe;
	unmount: () => Promise<void>;
}> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const probe: Probe = { done: [], live: { current: null } };
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<Harness probe={probe} />
			</I18nProvider>
		);
	});
	// Let the stub catalog load and the listener register.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		probe,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function emit(payload: Record<string, unknown>) {
	if (!installerHandler) {
		throw new Error("installer-progress listener was never registered");
	}
	installerHandler({ payload: { version: 1, ...payload } });
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("binary install lines are localized, component name included", async () => {
	const { probe, unmount } = await mountInJapanese();
	emit({ component: "ryu-gateway", phase: "binary", status: "started" });
	expect(probe.live.current).toBe(
		"モデルゲートウェイをインストールしています…"
	);
	emit({ component: "ryu-gateway", phase: "binary", status: "complete" });
	expect(probe.done.at(-1)).toBe("モデルゲートウェイをインストールしました");
	expect(probe.done.join("\n")).not.toContain("the model gateway");
	expect(probe.live.current).toBeNull();
	await unmount();
});

test("Core and bundled-defaults lines are localized", async () => {
	const { probe, unmount } = await mountInJapanese();
	emit({ component: "ryu-core", phase: "core", status: "started" });
	expect(probe.live.current).toBe("Ryu Core を起動しています…");
	emit({ component: "ryu-core", phase: "core", status: "complete" });
	expect(probe.done.at(-1)).toBe("Ryu Core は正常です");
	emit({ component: "bundled-defaults", phase: "defaults", status: "started" });
	expect(probe.live.current).toBe(
		"同梱のモデル、エンジン、スキルをインストールしています…"
	);
	await unmount();
});
