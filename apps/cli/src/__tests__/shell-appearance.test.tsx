/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CapturedFrame, TextAttributes } from "@opentui/core";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { AppResponseValue } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { Card } from "@/components/ui/card.tsx";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { ContributionsProvider } from "../core/ContributionsContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import { ProductModeProvider } from "../core/ProductModeContext.tsx";
import { OverlayProvider } from "../overlays/OverlayHost.tsx";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { StatusBar } from "../ui/StatusBar.tsx";
import { TerminalThemeProvider } from "../ui/TerminalThemeProvider.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { ToastHost, ToastProvider, useToast } from "../ui/toast.tsx";
import { SplitView } from "../workspace/SplitView.tsx";
import { TabStrip } from "../workspace/TabStrip.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

const TARGET = { url: "http://localhost:8980", token: null };
const PROOF_PATH = join(
	import.meta.dir,
	"../../../../docs/proof/cli-appearance-20260930/ryu-cli-agent-workspace.svg"
);
const REAL_FETCH = globalThis.fetch;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let testHome: string | null = null;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
let workspace: ReturnType<typeof useWorkspace> | null = null;

afterEach(async () => {
	globalThis.fetch = REAL_FETCH;
	await act(async () => {
		testSetup?.renderer.destroy();
	});
	testSetup = null;
	workspace = null;
	if (testHome) {
		rmSync(testHome, { force: true, recursive: true });
		testHome = null;
	}
	if (ORIGINAL_HOME === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = ORIGINAL_HOME;
	}
	if (ORIGINAL_USERPROFILE === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	}
});

function isolateHome(): void {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-shell-appearance-"));
	process.env.HOME = testHome;
	delete process.env.USERPROFILE;
}

function jsonResponse(body: AppResponseValue): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

function stubCore(): void {
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof REAL_FETCH>[0]) => {
			const url = isNativeText(input)
				? input
				: input instanceof URL
					? input.href
					: input.url;
			const path = new URL(url).pathname;
			if (path === "/api/health") {
				return Promise.resolve(jsonResponse({ ok: true }));
			}
			if (path === "/api/preferences/terminal-theme") {
				return Promise.resolve(
					jsonResponse({ value: { mode: "dark", preset: "ryu" } })
				);
			}
			if (path === "/api/agents") {
				return Promise.resolve(
					jsonResponse({
						agents: [
							{
								id: "builder",
								name: "Builder",
								title: "Build and verify",
								engine: "ryu",
								model: "gpt-6-sol",
								description:
									"Implements focused changes and checks the result.",
							},
							{ id: "reviewer", name: "Reviewer", engine: "ryu" },
							{ id: "researcher", name: "Researcher", engine: "openai" },
						],
					})
				);
			}
			if (path === "/api/agents/builder") {
				return Promise.resolve(
					jsonResponse({
						agent: {
							id: "builder",
							name: "Builder",
							title: "Build and verify",
							engine: "ryu",
							model: "gpt-6-sol",
							system_prompt:
								"Implement the requested change and verify its behavior.",
							tools: ["read", "edit", "terminal"],
						},
					})
				);
			}
			if (path === "/api/agents/builder/skills") {
				return Promise.resolve(jsonResponse({ skills: [] }));
			}
			if (path === "/api/agents/builder/tools") {
				return Promise.resolve(jsonResponse({ tools: [] }));
			}
			if (path === "/api/teams") {
				return Promise.resolve(
					jsonResponse({ teams: [{ id: "reviewers", name: "Reviewers" }] })
				);
			}
			if (path === "/api/spaces") {
				return Promise.resolve(
					jsonResponse({
						spaces: [
							{
								id: "cli",
								name: "CLI refresh",
								document_count: 4,
								created_at: 1,
								updated_at: 2,
							},
						],
					})
				);
			}
			if (path === "/api/meetings") {
				return Promise.resolve(
					jsonResponse({
						meetings: [{ id: "review", title: "Release review" }],
					})
				);
			}
			if (path === "/workflows") {
				return Promise.resolve(
					jsonResponse({
						workflows: [{ id: "verify", name: "Verify build", nodes: [] }],
					})
				);
			}
			if (path === "/api/conversations") {
				return Promise.resolve(
					jsonResponse([
						{
							id: "refresh",
							title: "Terminal visual refresh",
							folder: "Ryu",
							updated_at: "2026-09-30T00:00:00Z",
						},
						{
							id: "pinned",
							title: "UI direction",
							pinned: true,
						},
					])
				);
			}
			return Promise.resolve(jsonResponse({}));
		},
		{
			preconnect: (
				...args: Parameters<typeof REAL_FETCH.preconnect>
			): ReturnType<typeof REAL_FETCH.preconnect> =>
				REAL_FETCH.preconnect(...args),
		}
	);
}

function CaptureWorkspace() {
	workspace = useWorkspace();
	return null;
}

function ShellFixture() {
	return (
		<CoreProvider initial={TARGET}>
			<TerminalThemeProvider>
				<InputFocusProvider>
					<ToastProvider>
						<ChatIntentProvider>
							<ContributionsProvider>
								<WorkspaceProvider>
									<OverlayProvider>
										<ProductModeProvider>
											<CaptureWorkspace />
											<box
												backgroundColor={ryuTheme.colors.background}
												flexDirection="column"
												height="100%"
												width="100%"
											>
												<TabStrip />
												<box
													flexDirection="row"
													flexGrow={1}
													flexShrink={1}
													minHeight={0}
													overflow="hidden"
												>
													<Sidebar
														modeLabel="Agent"
														onOpenPalette={() => undefined}
														onSwitchMode={() => undefined}
														onSwitchNode={() => undefined}
													/>
													<SplitView />
												</box>
												<StatusBar
													hints={[
														{ keys: "^K", label: "palette" },
														{ keys: "^T", label: "new" },
														{ keys: "^W", label: "close" },
													]}
													left="Agent · localhost:8980"
												/>
											</box>
										</ProductModeProvider>
									</OverlayProvider>
								</WorkspaceProvider>
							</ContributionsProvider>
						</ChatIntentProvider>
					</ToastProvider>
				</InputFocusProvider>
			</TerminalThemeProvider>
		</CoreProvider>
	);
}

function CardFixture() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<box flexDirection="column">
				<Card title="Summary">
					<text>Groups use spacing by default.</text>
				</Card>
				<Card bordered title="Focused prompt">
					<text>The explicit frame stays available for modal focus.</text>
				</Card>
			</box>
		</ThemeProvider>
	);
}

async function flush(): Promise<void> {
	if (!testSetup) {
		return;
	}
	for (let pass = 0; pass < 5; pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await testSetup?.renderOnce();
		});
	}
}

function colorHex(color: {
	toInts: () => [number, number, number, number];
}): string {
	const [red, green, blue] = color.toInts();
	return `#${[red, green, blue]
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("")}`;
}

function colorOpacity(color: {
	toInts: () => [number, number, number, number];
}): number {
	return color.toInts()[3] / 255;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function renderSvg(frame: CapturedFrame): string {
	const cellWidth = 9.6;
	const cellHeight = 20;
	const width = frame.cols * cellWidth;
	const height = frame.rows * cellHeight;
	const background = ryuTheme.colors.background;
	const rows = frame.lines.map((line, rowIndex) => {
		let column = 0;
		const y = rowIndex * cellHeight;
		const spans = line.spans.map((span) => {
			const x = column * cellWidth;
			column += span.width;
			const spanWidth = span.width * cellWidth;
			const alpha = span.bg.toInts()[3];
			const backgroundHex = colorHex(span.bg);
			const backgroundRect =
				alpha > 0 && backgroundHex !== background
					? `<rect x="${x}" y="${y}" width="${spanWidth}" height="${cellHeight}" fill="${backgroundHex}" fill-opacity="${alpha / 255}"/>`
					: "";
			const visibleText = span.text.length > 0;
			const textNode = visibleText
				? `<text x="${x}" y="${y + 15}" fill="${colorHex(span.fg)}" fill-opacity="${colorOpacity(span.fg)}" font-weight="${span.attributes & TextAttributes.BOLD ? 700 : 400}" xml:space="preserve">${escapeXml(span.text)}</text>`
				: "";
			return `${backgroundRect}${textNode}`;
		});
		return spans.join("");
	});
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="${width}" height="${height}" fill="${background}"/>`,
		`<g font-family="SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="16">${rows.join("")}</g>`,
		"</svg>",
	].join("");
}

test("renders an unboxed agent list and detail shell and saves its visual proof", async () => {
	isolateHome();
	stubCore();
	testSetup = await testRender(<ShellFixture />, { height: 40, width: 140 });
	await flush();

	await act(async () => {
		workspace?.openTab("/agents");
	});
	await flush();
	await testSetup.mockInput.pressEnter();
	await flush();

	const frame = testSetup.captureCharFrame();
	expect(frame).toContain("Builder");
	expect(frame).toContain("attributes");
	expect(frame).toContain("Agent");
	expect(frame).toContain("Reviewers");
	expect(frame).toContain("tools");
	expect(frame).not.toMatch(/[╭╮╰╯]/);

	mkdirSync(dirname(PROOF_PATH), { recursive: true });
	writeFileSync(PROOF_PATH, renderSvg(testSetup.captureSpans()));
});

test("split workspace keeps a single divider without framing either pane", async () => {
	isolateHome();
	stubCore();
	testSetup = await testRender(<ShellFixture />, { height: 40, width: 140 });
	await flush();

	await act(async () => {
		workspace?.openTab("/agents");
		workspace?.splitActive();
	});
	await flush();

	const frame = testSetup.captureCharFrame();
	const dividerRows = frame.split("\n").filter((line) => line.includes("│"));
	expect(dividerRows.length).toBeGreaterThan(25);
	expect(frame).not.toMatch(/[╭╮╰╯]/);
});

test("cards stay flat by default and retain an explicit framed variant", async () => {
	testSetup = await testRender(<CardFixture />, { height: 10, width: 80 });
	await testSetup.renderOnce();

	const frame = testSetup.captureCharFrame();
	expect(frame).toContain("Summary");
	expect(frame).toContain("Focused prompt");
	expect(frame.match(/╭/g)).toHaveLength(1);
	expect(frame.match(/╰/g)).toHaveLength(1);
});

const LAYOUT_CASES = [
	{ height: 36, path: "/chat", width: 120 },
	{ height: 36, path: "/chat", width: 140 },
	{ height: 24, path: "/agents", width: 120 },
] as const;

for (const layout of LAYOUT_CASES) {
	test(`shell keeps the status bar on its own row at ${layout.width}x${layout.height} on ${layout.path}`, async () => {
		isolateHome();
		stubCore();
		testSetup = await testRender(<ShellFixture />, {
			height: layout.height,
			width: layout.width,
		});
		await flush();

		await act(async () => {
			workspace?.openTab(layout.path);
		});
		await flush();

		const frame = testSetup.captureCharFrame();
		const rows = frame.split("\n");
		while (rows.length > 0 && rows.at(-1)?.trim() === "") {
			rows.pop();
		}
		expect(rows).toHaveLength(layout.height);
		const statusRow = rows.at(-1) ?? "";
		expect(statusRow).toContain("^K palette");
		expect(statusRow).toContain("Agent · localhost:8980");
		expect(statusRow).not.toContain("╯");
		expect(frame).not.toMatch(/ConsoleD·w|D·w/);

		// The sidebar footer (NavUser) sits intact directly above the status bar.
		expect(rows.at(-2)?.slice(0, 24)).toContain("Inbox");

		// No scrollbar glyphs bleed into the sidebar between the nav cluster and
		// the first section header.
		const navEnd = rows.findIndex((row) => row.includes("Timeline"));
		const firstSection = rows.findIndex((row) => row.includes("AGENTS"));
		expect(navEnd).toBeGreaterThan(0);
		expect(firstSection).toBeGreaterThan(navEnd);
		for (const row of rows.slice(navEnd + 1, firstSection)) {
			expect(row.charAt(22)).not.toMatch(/[█▀]/);
		}
	});
}

test("empty sidebar sections collapse to a single header row", async () => {
	isolateHome();
	stubCore();
	testSetup = await testRender(<ShellFixture />, { height: 60, width: 120 });
	await flush();

	const frame = testSetup.captureCharFrame();
	expect(frame).toMatch(/▸ MEETINGS 0/);
	expect(frame).toMatch(/▸ ARCHIVED 0/);
	expect(frame).toMatch(/▾ AGENTS 3/);
	expect(frame).not.toContain("empty");

	// A user toggle overrides the data-derived default: expanding an empty
	// section shows its explicit empty hint.
	const rows = frame.split("\n");
	const meetingsRow = rows.findIndex((row) => row.includes("MEETINGS"));
	await act(async () => {
		await testSetup?.mockMouse.click(2, meetingsRow);
	});
	await flush();
	const expanded = testSetup.captureCharFrame();
	expect(expanded).toMatch(/▾ MEETINGS 0/);
	expect(expanded).toContain("empty");
});

let toastApi: ReturnType<typeof useToast> | null = null;

function CaptureToast() {
	toastApi = useToast();
	return null;
}

test("toasts float over a clipped main row without moving the status bar", async () => {
	testSetup = await testRender(
		<ThemeProvider theme={ryuTheme}>
			<ToastProvider>
				<CaptureToast />
				<box flexDirection="column" height="100%" width="100%">
					<box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
						{Array.from({ length: 30 }, (_, row) => (
							<text key={`filler-${row}`}>{`filler ${row}`}</text>
						))}
					</box>
					<StatusBar hints={[]} left="status" />
					<ToastHost />
				</box>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 12, width: 60 }
	);
	await flush();
	const before = testSetup.captureCharFrame().split("\n").slice(0, 12);
	await act(async () => {
		toastApi?.notify("first warning", "warning");
		toastApi?.notify("short note");
	});
	await flush();

	const rows = testSetup.captureCharFrame().split("\n").slice(0, 12);
	expect(rows.at(-1)).toBe(before.at(-1));
	expect(rows.at(-1)).toContain("status");
	expect(rows[0]).toBe(before[0]);
	expect(rows[1]).toContain("short note");
	expect(rows[2]).toContain("first warning");
	// The filler under the toast keeps its row: only the right side is covered.
	expect(rows[1]?.slice(0, 12)).toBe(before[1]?.slice(0, 12));
	expect(rows.join("\n")).not.toMatch(/short notes?\S/);
});
