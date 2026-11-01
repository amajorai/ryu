import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register({ url: "https://site.example/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const {
	ASSISTANT_LIGHT_SCHEME_CLASS,
	AssistantColorSchemeProvider,
	backgroundLightness,
	colorSchemeClass,
	detectHostColorScheme,
	useAssistantPopupLayer,
	useResolvedColorScheme,
} = await import("./color-scheme.tsx");
const { ASSISTANT_POPUP_LAYER } = await import("./skin.ts");

let root: Root | null = null;

function resetHost() {
	const html = document.documentElement;
	html.className = "";
	html.removeAttribute("data-theme");
	html.removeAttribute("style");
	document.body.className = "";
	document.body.removeAttribute("style");
	document.body.removeAttribute("data-bs-theme");
	document.body.innerHTML = "";
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	resetHost();
});

afterAll(async () => {
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

describe("detectHostColorScheme", () => {
	test("reads a .dark class or a theme attribute on the host", () => {
		document.documentElement.classList.add("dark");
		expect(detectHostColorScheme(document, false)).toBe("dark");
		resetHost();
		document.documentElement.setAttribute("data-theme", "light");
		expect(detectHostColorScheme(document, true)).toBe("light");
		resetHost();
		document.body.setAttribute("data-bs-theme", "dark");
		expect(detectHostColorScheme(document, false)).toBe("dark");
	});

	test("falls back to the page background, then the system preference", () => {
		document.body.style.backgroundColor = "rgb(12, 12, 14)";
		expect(detectHostColorScheme(document, false)).toBe("dark");
		document.body.style.backgroundColor = "rgb(250, 250, 250)";
		expect(detectHostColorScheme(document, true)).toBe("light");
		resetHost();
		expect(detectHostColorScheme(document, true)).toBe("dark");
		expect(detectHostColorScheme(document, false)).toBe("light");
	});
});

describe("backgroundLightness", () => {
	test("reads rgb and oklch, and ignores transparent fills", () => {
		expect(backgroundLightness("rgb(0, 0, 0)")).toBe(0);
		expect(backgroundLightness("rgb(255, 255, 255)")).toBeCloseTo(1);
		expect(backgroundLightness("oklch(0.145 0 0)")).toBeCloseTo(0.145);
		expect(backgroundLightness("rgba(0, 0, 0, 0)")).toBeNull();
		expect(backgroundLightness("transparent")).toBeNull();
	});
});

test("colorSchemeClass maps a scheme to the class that scopes it", () => {
	expect(colorSchemeClass("dark")).toBe("dark");
	expect(colorSchemeClass("light")).toBe(ASSISTANT_LIGHT_SCHEME_CLASS);
	expect(colorSchemeClass(null)).toBeUndefined();
});

function Probe({ preference }: { preference: "auto" | "light" | "dark" }) {
	const scheme = useResolvedColorScheme(preference);
	return (
		<AssistantColorSchemeProvider scheme={scheme}>
			<output data-scheme={scheme ?? "none"} />
			<PopupLayer />
		</AssistantColorSchemeProvider>
	);
}

function PopupLayer() {
	return <span data-popup-layer={useAssistantPopupLayer()} />;
}

function render(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(node));
	return container;
}

describe("useResolvedColorScheme", () => {
	test("auto follows the host when it switches theme", async () => {
		const container = render(<Probe preference="auto" />);
		const output = () =>
			container.querySelector("output")?.getAttribute("data-scheme");
		expect(output()).toBe("light");

		await act(async () => {
			document.documentElement.classList.add("dark");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(output()).toBe("dark");
	});

	test("a pinned scheme ignores the host and reaches portaled popups", () => {
		document.documentElement.classList.add("dark");
		const container = render(<Probe preference="light" />);
		expect(container.querySelector("output")?.getAttribute("data-scheme")).toBe(
			"light"
		);
		const layer = container
			.querySelector("[data-popup-layer]")
			?.getAttribute("data-popup-layer");
		expect(layer).toContain(ASSISTANT_POPUP_LAYER);
		expect(layer).toContain(ASSISTANT_LIGHT_SCHEME_CLASS);
	});
});
