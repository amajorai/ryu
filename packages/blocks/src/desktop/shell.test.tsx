import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopShell } from "./shell.tsx";

test("Bot mode renders agents with inline threads and no Sessions toggle", () => {
	const html = renderToStaticMarkup(
		<DesktopShell sidebarMode="bot">
			<div>Transcript</div>
		</DesktopShell>
	);

	expect(html).toContain('data-testid="hero-bot-mode-sidebar"');
	expect(html).toContain("Agents");
	expect(html).not.toContain("hero-bot-mode-sessions-tab");
	expect(html).toContain("Threads");
	expect(html).toContain("Refactor the auth flow");
	expect(html).toContain("SSE fix follow-up");
	expect(html).toContain("Follow-up draft is ready");
	expect(html).toContain("Reviewed the launch checklist");
});

test("default shell keeps the existing stacked sections", () => {
	const html = renderToStaticMarkup(
		<DesktopShell>
			<div>Transcript</div>
		</DesktopShell>
	);

	expect(html).toContain("Teams");
	expect(html).toContain("Spaces");
	expect(html).toContain("Chats");
	expect(html).not.toContain('data-testid="hero-bot-mode-sidebar"');
});

test("trust mode keeps the landing showcase focused on existing AI tools", () => {
	const html = renderToStaticMarkup(
		<DesktopShell sidebarMode="trust">
			<div>Transcript</div>
		</DesktopShell>
	);

	expect(html).toContain('data-testid="hero-trust-mode-sidebar"');
	expect(html).toContain("ChatGPT");
	expect(html).toContain("Claude");
	expect(html).toContain("History");
	expect(html).not.toContain("Agents");
	expect(html).not.toContain("Sessions");
});
