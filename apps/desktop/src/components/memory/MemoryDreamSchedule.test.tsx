import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Keep Bun's own network stack across DOM registration: the Dream screen talks
// to a real HTTP peer below, not a mocked API module. A sibling suite may have
// left the DOM registered, so start from Bun's globals and restore them after.
if (GlobalRegistrator.isRegistered) {
	await GlobalRegistrator.unregister();
}
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { MemoryDreamReview } = await import("./MemoryDreamReview.tsx");
// The schedule card renders inside the review; importing it keeps the module
// under test explicit for the pre-commit companion check.
await import("./MemoryDreamSchedule.tsx");
const { formatLocalDateTime } = await import("@/src/lib/locale-format.ts");

const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/en",
	locale: "en",
	messages: {},
	name: "English",
	schemaVersion: 1,
	version: "1.0.0",
};

const SETTINGS_PATH = "/api/memory/dream/review/settings";

// A Core that stores Dream settings like the real one (PATCH merges, then
// returns the saved settings) and reports whether it is organization-bound.
const node = {
	managed: false,
	orgRoute: true,
	patches: [] as Record<string, unknown>[],
	settings: { automatic: true, quiet_hours_end: 8, quiet_hours_start: 22 },
};

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === SETTINGS_PATH && request.method === "PATCH") {
			const patch = (await request.json()) as Record<string, unknown>;
			node.patches.push(patch);
			node.settings = { ...node.settings, ...patch };
			return NativeResponse.json({ settings: node.settings });
		}
		if (pathname === SETTINGS_PATH) {
			return NativeResponse.json({ settings: node.settings });
		}
		if (pathname === "/api/gateway/org-features" && node.orgRoute) {
			return NativeResponse.json({
				available: true,
				features: {},
				managed: node.managed,
			});
		}
		if (pathname === "/api/preferences/chat-memory-enabled") {
			return NativeResponse.json({
				key: "chat-memory-enabled",
				value: "true",
			});
		}
		if (pathname === "/api/memory/dream/review") {
			return NativeResponse.json({
				review: { generated_at: 0, proposals: [] },
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

afterAll(async () => {
	core.stop(true);
	await GlobalRegistrator.unregister();
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 80 && !check(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
}

function hourLabel(hour: number): string {
	return formatLocalDateTime(new Date(2020, 0, 1, hour), { hour: "numeric" });
}

describe("Dream automatic review settings", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		node.managed = false;
		node.orgRoute = true;
		node.patches = [];
		node.settings = {
			automatic: true,
			quiet_hours_end: 8,
			quiet_hours_start: 22,
		};
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<MemoryDreamReview target={{ token: null, url: core.url.origin }} />
				</I18nProvider>
			);
		});
		await waitFor(
			() =>
				container.querySelector("[data-testid=dream-schedule]") !== null &&
				!container.querySelector("[data-slot=skeleton]") &&
				container.textContent?.includes("No new memories to review") === true
		);
	}

	function automaticSwitch(): HTMLElement | null {
		return container.querySelector(
			"[data-testid=dream-schedule] [role=switch]"
		);
	}

	function quietSelect(id: string): HTMLElement | null {
		return container.querySelector(`#${id}`);
	}

	async function choose(id: string, label: string): Promise<void> {
		await act(async () => {
			quietSelect(id)?.click();
		});
		await waitFor(() => document.querySelector("[role=option]") !== null);
		const option = Array.from(
			document.querySelectorAll<HTMLElement>("[role=option]")
		).find((item) => item.textContent?.trim() === label);
		if (!option) {
			throw new Error(`No quiet-hours option ${label}`);
		}
		await act(async () => {
			option.click();
		});
	}

	it("shows the saved quiet hours and saves a new start hour", async () => {
		await mount();
		expect(automaticSwitch()?.getAttribute("aria-checked")).toBe("true");
		expect(quietSelect("dream-quiet-start")?.textContent).toContain(
			hourLabel(22)
		);
		expect(quietSelect("dream-quiet-end")?.textContent).toContain(hourLabel(8));
		expect(
			quietSelect("dream-quiet-start")?.hasAttribute("data-disabled")
		).toBe(false);

		await choose("dream-quiet-start", hourLabel(23));
		await waitFor(() => node.patches.length > 0);
		expect(node.patches).toEqual([{ quiet_hours_start: 23 }]);
		expect(node.settings.quiet_hours_start).toBe(23);
		await waitFor(
			() =>
				quietSelect("dream-quiet-start")?.textContent?.includes(
					hourLabel(23)
				) === true
		);
		expect(quietSelect("dream-quiet-start")?.textContent).toContain(
			hourLabel(23)
		);
	});

	it("disables quiet hours while automatic review is off", async () => {
		node.settings.automatic = false;
		await mount();
		expect(automaticSwitch()?.getAttribute("aria-checked")).toBe("false");
		expect(
			quietSelect("dream-quiet-start")?.hasAttribute("data-disabled")
		).toBe(true);
		expect(quietSelect("dream-quiet-end")?.hasAttribute("data-disabled")).toBe(
			true
		);
	});

	it("explains that automatic review never runs on an organization node", async () => {
		node.managed = true;
		await mount();
		await waitFor(
			() =>
				container.querySelector("[data-testid=dream-automatic-managed]") !==
				null
		);
		const switchElement = automaticSwitch();
		// Saved as on, but Core never runs it here: show what actually happens.
		expect(switchElement?.getAttribute("aria-checked")).toBe("false");
		expect(switchElement?.hasAttribute("data-disabled")).toBe(true);
		expect(
			container.querySelector("[data-testid=dream-automatic-managed]")
				?.textContent
		).toContain("shared with your organization");
		expect(quietSelect("dream-quiet-start")).toBe(null);

		await act(async () => {
			switchElement?.click();
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(node.patches).toEqual([]);
	});

	it("treats a Core without the organization route as unbound", async () => {
		node.orgRoute = false;
		await mount();
		expect(
			container.querySelector("[data-testid=dream-automatic-managed]")
		).toBe(null);
		expect(automaticSwitch()?.getAttribute("aria-checked")).toBe("true");
		expect(automaticSwitch()?.hasAttribute("data-disabled")).toBe(false);
	});
});
