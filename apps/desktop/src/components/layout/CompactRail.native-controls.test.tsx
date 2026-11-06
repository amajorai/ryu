import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The roster and the account avatar read live stores; the clearance under test
// lives on the rail itself, so they render as nothing here. Bun's module mocks
// are process-wide, so keep the real auth-client exports for sibling suites.
const realAuthClient = { ...(await import("@/lib/auth-client.ts")) };
mock.module("@/lib/auth-client.ts", () => ({
	...realAuthClient,
	useSession: () => ({ data: null }),
}));
mock.module("./compact-rail-agents.tsx", () => ({
	CompactRailAgents: () => null,
	RailDivider: () => null,
}));

// React DOM and Base UI read the DOM globals at import, so load them only after
// the globals above exist (static imports would hoist ahead of them).
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { CompactRail } = await import("./CompactRail.tsx");

let mounted: { host: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { host, root } = mounted;
		act(() => root.unmount());
		host.remove();
		mounted = null;
	}
	document.documentElement.removeAttribute("dir");
});

/** The rail's top padding once `rtl:` variants override the base class. */
function topPadding(className: string, dir: "ltr" | "rtl"): string {
	let padding = "";
	for (const token of className.split(/\s+/)) {
		if (token.startsWith("pt-")) {
			padding = padding || token;
		} else if (dir === "rtl" && token.startsWith("rtl:pt-")) {
			padding = token.slice(4);
		}
	}
	return padding;
}

async function renderRail({
	dir,
	isMac,
	surface,
}: {
	dir: "ltr" | "rtl";
	isMac: boolean;
	surface: "desktop" | "web";
}) {
	document.documentElement.dir = dir;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted = { host, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="en"
				initialPackId={null}
			>
				<AppSurfaceProvider surface={surface}>
					<CompactRail
						isMac={isMac}
						onOpenNavigation={() => undefined}
						onSearch={() => undefined}
						showSearch
					/>
				</AppSurfaceProvider>
			</I18nProvider>
		);
	});
	const rail = host.querySelector<HTMLElement>('[data-testid="compact-rail"]');
	if (!rail) {
		throw new Error("The compact rail did not render.");
	}
	return {
		controls: document.documentElement.getAttribute("data-ryu-compact-rail"),
		padding: topPadding(rail.className, dir),
	};
}

describe("compact rail clearance for the physical native window controls", () => {
	test("macOS: the rail drops below the traffic lights only left to right", async () => {
		const ltr = await renderRail({
			dir: "ltr",
			isMac: true,
			surface: "desktop",
		});
		expect(ltr).toEqual({ controls: "traffic-lights", padding: "pt-11" });
		act(() => mounted?.root.unmount());
		mounted?.host.remove();
		mounted = null;
		// Right to left the rail is on the right; the lights stay on the left.
		const rtl = await renderRail({
			dir: "rtl",
			isMac: true,
			surface: "desktop",
		});
		expect(rtl).toEqual({ controls: "traffic-lights", padding: "pt-2" });
	});

	test("Windows: the rail drops below the caption buttons only right to left", async () => {
		const ltr = await renderRail({
			dir: "ltr",
			isMac: false,
			surface: "desktop",
		});
		expect(ltr).toEqual({ controls: "caption-buttons", padding: "pt-2" });
		act(() => mounted?.root.unmount());
		mounted?.host.remove();
		mounted = null;
		const rtl = await renderRail({
			dir: "rtl",
			isMac: false,
			surface: "desktop",
		});
		expect(rtl).toEqual({ controls: "caption-buttons", padding: "pt-12" });
	});

	test("a browser build has no native controls to clear", async () => {
		const rtl = await renderRail({ dir: "rtl", isMac: true, surface: "web" });
		expect(rtl).toEqual({ controls: "", padding: "pt-2" });
	});

	test("the stylesheet widens the rail for the lights and keeps the caption reserve, keyed on dir", () => {
		const css = readFileSync(new URL("./CompactRail.css", import.meta.url), {
			encoding: "utf8",
		});
		expect(css).toContain(
			':root[data-ryu-compact-rail="traffic-lights"]:not([dir="rtl"]) {\n\t--ryu-compact-rail-width: 5.5rem;'
		);
		const reserve = css.slice(
			css.indexOf(':root[data-ryu-compact-rail="caption-buttons"][dir="rtl"]')
		);
		expect(reserve).toMatch(
			/^[^}]*\.ryu-nav-cluster-reserve\s*\{\s*display: block;\s*width: calc\(12rem - var\(--ryu-compact-rail-width\)\);/
		);
	});
});
