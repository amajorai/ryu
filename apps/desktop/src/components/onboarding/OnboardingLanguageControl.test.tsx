import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LANGUAGE_PACK_STORAGE_KEY, type LanguagePack } from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Retain Bun's network stack across DOM registration: the installed packs are
// read by the production client over real loopback HTTP, not through a mock.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const ownsDomRegistration = globalThis.document === undefined;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, setLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { topBarInsets } = await import("@/src/lib/window-chrome-layout.ts");
const { isMac } = await import("@ryu/hotkeys/chord");
const { LanguagePackBridge } = await import("../LanguagePackBridge.tsx");
const { OnboardingLanguageControl, onboardingPhaseKeepsLanguage } =
	await import("./OnboardingLanguageControl.tsx");
const { WelcomeStep } = await import("./WelcomeStep.tsx");

/** An installed pack that is switched on: usable at once. */
const dutch: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/onboarding-dutch",
	name: "Nederlands",
	version: "1.0.0",
	locale: "nl",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installeren" },
	enabled: true,
};
/** An installed pack the node would have to enable first. */
const swedish: LanguagePack = {
	...dutch,
	id: "coverage/onboarding-swedish",
	name: "Svenska",
	locale: "sv",
	messages: { "common.install": "Installera" },
	enabled: false,
};
const admissions: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const route = new URL(request.url).pathname;
		admissions.push(`${request.method} ${route}`);
		if (route !== "/api/language-packs/installed" || request.method !== "GET") {
			return new NativeResponse("undeclared route", { status: 404 });
		}
		return NativeResponse.json({ packs: [dutch, swedish] });
	},
});
function seedFixtureNode() {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "onboarding-language-proof",
		nodes: [
			{
				name: "onboarding-language-proof",
				url: server.url.origin,
				token: "onboarding-language-token",
			},
		],
	});
}
seedFixtureNode();
beforeEach(seedFixtureNode);

function Consumer() {
	const { direction, locale, selectedPackId } = useI18n();
	return (
		<output
			data-direction={direction}
			data-language-consumer=""
			data-locale={locale}
			data-pack={selectedPackId ?? ""}
		/>
	);
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;
let continued = 0;
const reactErrors: unknown[] = [];
const recordWindowError = (event: ErrorEvent) => reactErrors.push(event.error);
window.addEventListener("error", recordWindowError);

async function wait(milliseconds: number) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
	});
}
async function settle(predicate: () => boolean, attempts = 150) {
	for (let count = 0; count < attempts && !predicate(); count += 1) {
		await wait(10);
	}
	if (!predicate()) {
		throw new Error(`Condition not reached: ${predicate.toString()}`);
	}
}
function consumer() {
	return element!.querySelector<HTMLOutputElement>("[data-language-consumer]")!;
}
function trigger() {
	return element!.querySelector<HTMLButtonElement>(
		'[data-testid="onboarding-language-trigger"]'
	)!;
}
function menu() {
	return document.querySelector<HTMLElement>(
		'[data-testid="onboarding-language-menu"]'
	);
}
function options() {
	return Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
	);
}
function beat() {
	return element!.querySelector<HTMLElement>(
		'[data-testid="onboarding-welcome-beat"]'
	)!;
}
/** Mount the welcome screen (which carries the control) under the real bridge. */
async function mountWelcome() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element, {
		onUncaughtError: (error) => reactErrors.push(error),
	});
	const reads = admissions.length;
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<WelcomeStep
					onContinue={() => {
						continued += 1;
					}}
				/>
				<Consumer />
			</LanguagePackBridge>
		)
	);
	await settle(() => admissions.length > reads);
}
async function openMenu() {
	await act(async () => trigger().click());
	await settle(() => options().length > 0);
}
async function choose(name: string) {
	await openMenu();
	const option = options().find((candidate) =>
		candidate.textContent?.includes(name)
	);
	if (!option) {
		throw new Error(`No language option named ${name}`);
	}
	await act(async () => option.click());
	await settle(() => menu() === null);
}
async function press(key: string, target: EventTarget) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	continued = 0;
	// Reset the session's mode first: the setter itself writes to storage.
	setLanguageMode("auto");
	localStorage.clear();
	const errors = reactErrors.splice(0);
	if (errors.length > 0) {
		throw new Error(`React or window errors: ${errors.map(String).join("; ")}`);
	}
});
afterAll(async () => {
	window.removeEventListener("error", recordWindowError);
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("lists Auto detect, English and only the languages that apply at once", async () => {
	await mountWelcome();
	await settle(() => element!.textContent!.includes("English"));
	expect(trigger().textContent).toBe("English");
	await openMenu();
	await settle(() => options().some((o) => o.textContent === "Nederlands"));

	const names = options().map((option) => option.textContent ?? "");
	// Following the system is the default, and says which language that is.
	expect(names[0]).toBe("Auto detectEnglish");
	expect(options()[0]?.getAttribute("aria-checked")).toBe("true");
	expect(names[1]).toBe("English");
	expect(options()[1]?.getAttribute("aria-checked")).toBe("false");
	for (const official of [
		"Español",
		"Français",
		"Deutsch",
		"日本語",
		"العربية",
	]) {
		expect(names).toContain(official);
	}
	// An enabled installed pack is offered; one the node must enable is not,
	// and neither is the English flavor pack.
	expect(names).toContain("Nederlands");
	expect(names).not.toContain("Svenska");
	expect(names.join("|")).not.toContain("chronically online");
	// A language's own name carries its language and is never translated.
	const french = options().find((o) => o.textContent === "Français")!;
	const endonym = french.querySelector("[lang]")!;
	expect(endonym.getAttribute("lang")).toBe("fr");
	expect(endonym.getAttribute("data-ryu-i18n")).toBe("off");
});

test("choosing French re-renders the welcome and writes the keys Settings writes", async () => {
	await mountWelcome();
	await settle(() => beat().textContent === "Hi, I'm Ryu.");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBeNull();
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();

	await choose("Français");

	await settle(() => beat().textContent === "Bonjour, je suis Ryu.");
	expect(trigger().textContent).toBe("Français");
	expect(consumer().dataset.pack).toBe("official/fr");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe("official/fr");
	expect(continued).toBe(0);

	// Back to following the system: the fixed pack is forgotten again. The
	// menu itself now reads in French.
	await choose("Détection automatique");
	await settle(() => beat().textContent === "Hi, I'm Ryu.");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(options()).toHaveLength(0);
});

test("Arabic flips the direction at once", async () => {
	await mountWelcome();
	expect(consumer().dataset.direction).toBe("ltr");
	await choose("العربية");
	await settle(() => consumer().dataset.direction === "rtl");
	expect(consumer().dataset.locale).toBe("ar");
	expect(trigger().textContent).toBe("العربية");
});

test("the welcome waits while the menu is open, and Escape closes it without skipping", async () => {
	await mountWelcome();
	await settle(() => beat().dataset.beat === "sentence");
	await openMenu();

	// Longer than the greeting beat (2.4 s): it must still be on screen.
	await wait(2800);
	expect(beat().dataset.beat).toBe("sentence");
	expect(continued).toBe(0);

	await press("Escape", document.activeElement ?? document.body);
	await settle(() => menu() === null);
	expect(continued).toBe(0);
	expect(beat().dataset.beat).toBe("sentence");

	// The beat starts over once the menu is closed, then moves on as before.
	await settle(() => beat().dataset.beat === "welcome", 400);
	expect(continued).toBe(0);
}, 20_000);

test("Enter on the language button is not a skip; Escape elsewhere still is", async () => {
	await mountWelcome();
	await press("Enter", trigger());
	expect(continued).toBe(0);
	await press("Escape", document.body);
	expect(continued).toBe(1);
});

test("the page keeps the control on the two screens after the welcome only", () => {
	expect(onboardingPhaseKeepsLanguage("updates")).toBe(true);
	expect(onboardingPhaseKeepsLanguage("choose")).toBe(true);
	// The welcome places its own, and it is gone once setup starts.
	for (const phase of ["intro", "connect", "installing", "theme", "done"]) {
		expect(onboardingPhaseKeepsLanguage(phase)).toBe(false);
	}
});

test("the bar clears the native window controls, and a browser has none to clear", async () => {
	async function barClasses(surface: "desktop" | "web") {
		element = document.createElement("div");
		document.body.append(element);
		root = createRoot(element, {
			onUncaughtError: (error) => reactErrors.push(error),
		});
		await act(async () =>
			root!.render(
				<AppSurfaceProvider surface={surface}>
					<LanguagePackBridge>
						<OnboardingLanguageControl />
					</LanguagePackBridge>
				</AppSurfaceProvider>
			)
		);
		const bar = element.querySelector<HTMLElement>(
			'[data-testid="onboarding-language-bar"]'
		)!;
		const classes = bar.className.split(/\s+/);
		await act(async () => root!.unmount());
		element.remove();
		return classes;
	}
	const reserved = topBarInsets({
		isMac: isMac(),
		nativeWindowChrome: true,
	}).split(" ");
	expect(reserved.length).toBeGreaterThan(0);

	const desktop = await barClasses("desktop");
	for (const inset of reserved) {
		expect(desktop).toContain(inset);
	}
	// The bar lets the window drag through; only the button takes input.
	expect(desktop).toContain("pointer-events-none");
	expect(desktop).toContain("justify-end");

	const web = await barClasses("web");
	for (const inset of reserved) {
		expect(web).not.toContain(inset);
	}
	expect(web).toContain("px-6");
});

test("renders nothing without a language provider", async () => {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element, {
		onUncaughtError: (error) => reactErrors.push(error),
	});
	await act(async () => root!.render(<OnboardingLanguageControl />));
	expect(element.innerHTML).toBe("");
});
