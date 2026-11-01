import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

// The workspace store reads localStorage at import, so load the rail only after
// the DOM globals above exist (static imports would hoist ahead of them).
const { SIDEBAR_PROJECT_RAIL_KEY, SIDEBAR_RAIL_PROJECT_KEY } = await import(
	"@/src/hooks/useSidebarProjectRail.ts"
);
const { projectInitials, SidebarProjectRail, SidebarProjectRailFrame } =
	await import("./sidebar-project-rail.tsx");

const projects = [
	{ conversations: [], name: "ryu-private", path: "/w/ryu", sourceFolders: [] },
	{ conversations: [], name: "website", path: "/w/site", sourceFolders: [] },
];

beforeEach(() => {
	localStorage.clear();
});

describe("projectInitials", () => {
	test("uses the first letters of the first two words", () => {
		expect(projectInitials("ryu-private")).toBe("RP");
		expect(projectInitials("Marketing site")).toBe("MS");
		expect(projectInitials("website")).toBe("WE");
		expect(projectInitials("  ")).toBe("?");
	});
});

describe("SidebarProjectRail", () => {
	test("renders Home and one button per project, Home active by default", () => {
		const html = renderToStaticMarkup(
			<SidebarProjectRail projects={projects} />
		);
		expect(html).toContain('aria-label="All projects"');
		expect(html).toContain('aria-label="ryu-private"');
		expect(html).toContain('aria-label="website"');
		expect(html.match(/aria-current="page"/g)?.length).toBe(1);
		expect(html.indexOf('aria-current="page"')).toBeLessThan(
			html.indexOf('aria-label="ryu-private"')
		);
	});

	test("the frame renders the panel alone while the rail is off", () => {
		const html = renderToStaticMarkup(
			<SidebarProjectRailFrame projects={projects}>
				<p>panel</p>
			</SidebarProjectRailFrame>
		);
		expect(html).toBe("<p>panel</p>");
	});

	test("the frame shows the rail beside the panel once enabled", async () => {
		localStorage.setItem(SIDEBAR_PROJECT_RAIL_KEY, "true");
		localStorage.setItem(SIDEBAR_RAIL_PROJECT_KEY, "/w/site");
		// A client render: the server snapshot of the stored preferences is the
		// default (rail off), so only the browser sees the opt-in.
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(() => {
			root.render(
				<SidebarProjectRailFrame projects={projects}>
					<p>panel</p>
				</SidebarProjectRailFrame>
			);
		});
		const rail = host.querySelector('[data-testid="sidebar-project-rail"]');
		expect(rail).not.toBeNull();
		expect(host.textContent).toContain("panel");
		const active = host.querySelector('[aria-current="page"]');
		expect(active?.getAttribute("aria-label")).toBe("website");
		await act(() => root.unmount());
		host.remove();
	});
});
