// Standalone browser story for the REAL `CoworkContextPanel` Sources section —
// the "what did this run actually touch" list in the pinned summary rail.
//
// The section used to render one row per CONNECTOR ("Web search", "Local files")
// and nothing else, so a user could see THAT the run searched the web without
// ever seeing WHICH links or files. Each connector now expands in place.
//
// This is a real-browser story rather than a unit test because the expansion is
// nested inside the `BouncyAccordion`, whose open height comes from a
// `ResizeObserver` on its content: a group that expands into a fixed-height box
// would pin `offsetHeight` and the section would clip its own list. Only a real
// layout engine says whether the outer section actually grows.
//
// The panel is mounted with `runId={null}` so it makes no Core requests — every
// section here is derived from the message stream alone, which is exactly the
// substrate under test.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
	CoworkContextPanel,
	SourcesWorkspacePanel,
} from "../../src/components/panels/CoworkContextPanel.tsx";
import "../../src/index.css";

const MESSAGES = [
	{
		role: "user",
		parts: [
			{
				filename: "Startup Runway v2.0.pdf",
				mediaType: "application/pdf",
				type: "file",
			},
			{
				filename: "Startup_Runway_Weekly_Template_v2_Original.pptx",
				mediaType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				type: "file",
			},
			{ text: "Look into the effort slider colours.", type: "text" },
		],
	},
	{
		role: "assistant",
		parts: [
			{
				type: "tool-Grep",
				state: "output-available",
				input: { pattern: "effortFillColor", path: "apps/desktop/src" },
			},
			{
				type: "tool-Read",
				state: "output-available",
				input: {
					file_path:
						"/repo/apps/desktop/components/agent-elements/input/effort-slider-row.tsx",
				},
			},
			{
				type: "tool-Edit",
				state: "output-available",
				input: { file_path: "/repo/apps/desktop/src/lib/effort-colors.ts" },
			},
			{
				type: "tool-Bash",
				state: "output-available",
				input: { command: "bun test src/lib/effort-colors.test.ts" },
			},
			{
				type: "tool-WebFetch",
				state: "output-available",
				input: { url: "https://oklch.com/" },
				output: { title: "OKLCH colour picker" },
			},
			{
				type: "tool-WebSearch",
				state: "output-available",
				input: { query: "oklch interpolation gamut clipping" },
				output: {
					results: [
						{
							title: "Colour interpolation in CSS",
							url: "https://developer.mozilla.org/color_interpolation",
						},
						{
							title: "Gamut mapping explained",
							url: "https://evilmartians.com/gamut-mapping",
						},
						{
							title: "Perceptual colour spaces",
							url: "https://example.com/perceptual-colour",
						},
						{
							title: "OKLCH browser support",
							url: "https://example.com/oklch-support",
						},
					],
				},
			},
			{
				type: "dynamic-tool",
				toolName: "mcp.linear.create_issue",
				state: "output-available",
				input: { name: "Brighten the dark-mode ramp" },
			},
		],
	},
];

const queryClient = new QueryClient();

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<div className="dark grid h-screen grid-cols-[18rem_minmax(0,1fr)] bg-background text-foreground">
				<div className="min-w-0 p-2" data-testid="pinned-summary-sources-proof">
					<CoworkContextPanel
						maxItemsPerSection={5}
						messages={MESSAGES}
						onOpenSources={() => {
							document.body.dataset.sourcesOpened = "true";
						}}
						runId={null}
						target={{ url: "http://localhost:0", token: null }}
						variant="summary"
					/>
				</div>
				<div
					className="min-w-0 border-border border-l"
					data-testid="workspace-sources-proof"
				>
					<SourcesWorkspacePanel messages={MESSAGES} />
				</div>
			</div>
		</QueryClientProvider>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(<Story />);
}
