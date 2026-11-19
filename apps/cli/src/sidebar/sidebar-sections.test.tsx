/* @jsxImportSource @opentui/react */
// The split-out sidebar sections render their capitalized headers, items and
// project chats through the shared RowBox, and fold to the header alone.

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { testRender } from "../__tests__/cli-test-render.ts";
import { CoreProvider } from "../core/CoreContext.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { WorkspaceProvider } from "../workspace/WorkspaceContext.tsx";
import { LEADING_SECTIONS } from "./rows.ts";
import { SidebarFocusContext } from "./sidebar-row.tsx";
import { ProjectsSection, SidebarSection } from "./sidebar-sections.tsx";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const AGENTS = LEADING_SECTIONS[0];
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

function Harness({ collapsed }: { collapsed: boolean }) {
	if (!AGENTS) {
		return null;
	}
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<WorkspaceProvider>
					<SidebarFocusContext.Provider
						value={{ focusKey: null, release: () => undefined }}
					>
						<box flexDirection="column" width={30}>
							<SidebarSection
								collapsed={collapsed}
								items={[
									{ badge: "2", id: "a1", label: "Helper", path: "/agents/a1" },
								]}
								onToggle={() => undefined}
								section={AGENTS}
							/>
							<ProjectsSection
								collapsed={collapsed}
								onToggle={() => undefined}
								projects={[
									{
										chats: [{ id: "c1", label: "Kickoff", path: "/chat/c1" }],
										id: "p1",
										name: "Launch",
									},
								]}
							/>
						</box>
					</SidebarFocusContext.Provider>
				</WorkspaceProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

async function frameOf(collapsed: boolean): Promise<string> {
	setup = await testRender(<Harness collapsed={collapsed} />, {
		height: 16,
		width: 40,
	});
	await setup.renderOnce();
	return setup.captureCharFrame();
}

test("expanded sections show capitalized headers, items and project chats", async () => {
	const frame = await frameOf(false);
	expect(frame).toContain("AGENTS");
	expect(frame).toContain("Helper");
	expect(frame).toContain("PROJECTS");
	expect(frame).toContain("Launch");
	expect(frame).toContain("Kickoff");
});

test("collapsed sections keep only their headers", async () => {
	const frame = await frameOf(true);
	expect(frame).toContain("▸");
	expect(frame).toContain("AGENTS");
	expect(frame).toContain("PROJECTS");
	expect(frame).not.toContain("Helper");
	expect(frame).not.toContain("Kickoff");
});
