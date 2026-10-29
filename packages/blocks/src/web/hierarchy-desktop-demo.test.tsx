import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HierarchyDesktopDemo } from "./hierarchy-desktop-demo.tsx";

test("hero demo shows the unified sidebar and a project main thread", () => {
	const html = renderToStaticMarkup(<HierarchyDesktopDemo />);

	expect(html).toContain('data-testid="hierarchy-desktop-demo"');
	expect(html).toContain('data-testid="hierarchy-demo-sidebar"');
	// Sidebar mirrors the desktop: bots, then "Projects & chats" holding
	// Projects / Chats / a user section, one row style. Group conversations
	// such as Reviewers sit under Chats, not in the Bots roster.
	expect(html).toContain("Bots");
	expect(html).toContain("Projects &amp; chats");
	expect(html).toContain("Product launch");
	expect(html).toContain("Launch week");
	const chats = html.indexOf(">Chats<");
	expect(chats).toBeGreaterThan(html.indexOf("Projects &amp; chats"));
	expect(html.indexOf("Reviewers")).toBeGreaterThan(chats);
	// Main thread: delegated work renders as the real session cards.
	expect(html.match(/data-testid="session-card"/g)?.length).toBe(3);
	expect(html).toContain("Open session");
	expect(html).toContain("Sessions (3)");
	expect(html).toContain("Defaults");
});
