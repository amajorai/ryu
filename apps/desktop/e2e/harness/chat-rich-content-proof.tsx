import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";
import agentGeneratedReferenceUrl from "./chat-rich-content-proof/agent-reference.png?inline";
import briefCoverUrl from "./chat-rich-content-proof/brief-cover.png?inline";
import finalSlideUrl from "./chat-rich-content-proof/final-slide.png?inline";
import launchNotesUrl from "./chat-rich-content-proof/launch-notes.png?inline";
import reviewGridUrl from "./chat-rich-content-proof/review-grid.png?inline";
import runwayMapUrl from "./chat-rich-content-proof/runway-map.png?inline";
import weeklyTemplateUrl from "./chat-rich-content-proof/weekly-template.png?inline";

const agentReferenceUrl = new URL("./agent-reference.svg", window.location.href)
	.href;

// Attached images reach the transcript as `data:image/png;base64,...` file
// parts, the shape `fileToDataUrl` gives a locally attached file; `?inline`
// makes Vite encode each PNG fixture that way. Shared media rendering admits
// only raster image data URLs and refuses `data:image/svg+xml` (SVG is
// scriptable), so an SVG data URL here renders as a file chip, not an image.
const USER_IMAGES = [
	{ filename: "brief-cover.png", url: briefCoverUrl },
	{ filename: "weekly-template.png", url: weeklyTemplateUrl },
	{ filename: "runway-map.png", url: runwayMapUrl },
	{ filename: "launch-notes.png", url: launchNotesUrl },
	{ filename: "review-grid.png", url: reviewGridUrl },
	{ filename: "final-slide.png", url: finalSlideUrl },
] as const;

const USER_MESSAGE: UIMessage & { createdAt: string } = {
	createdAt: "2026-08-29T18:52:00.000Z",
	id: "rich-user",
	parts: [
		{
			filename: "Startup Runway v2.0.pdf",
			mediaType: "application/pdf",
			type: "file",
			url: "data:application/pdf;base64,JVBERi0xLjQK",
		},
		{
			filename: "Startup_Runway_Weekly_Template_v2_Original.docx",
			mediaType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			type: "file",
			url: "data:application/octet-stream;base64,AA==",
		},
		...USER_IMAGES.map<UIMessage["parts"][number]>((image) => ({
			filename: image.filename,
			mediaType: "image/png",
			type: "file",
			url: image.url,
		})),
		{
			text: `Use these materials to make a good deck.

| Material | Purpose | Status |
| --- | --- | --- |
| Runway brief | Narrative | Ready |
| Weekly template | Slide rhythm | Ready |`,
			type: "text",
		},
	],
	role: "user",
};

const MERMAID_FENCE = "```";
const ASSISTANT_MARKDOWN = `Here is a structured first pass. The table and diagram keep their own controls, while the images remain vectors in the transcript.

| Source | Use in deck | Status |
| --- | --- | --- |
| Startup Runway v2.0.pdf | Narrative and numbers | Ready |
| Weekly template | Slide rhythm | Ready |
| Review grid | Final QA | In progress |

${MERMAID_FENCE}mermaid
flowchart LR
  Brief[Brief] --> Outline[Outline]
  Outline --> Draft[Draft deck]
  Draft --> Review[Review]
  Review --> Final[Final deck]
${MERMAID_FENCE}

![Agent visual reference](${agentReferenceUrl})`;

const ASSISTANT_MESSAGE: UIMessage & { createdAt: string } = {
	createdAt: "2026-08-29T18:53:00.000Z",
	id: "rich-assistant",
	parts: [
		{ text: ASSISTANT_MARKDOWN, type: "text" },
		{
			filename: "agent-reference.png",
			mediaType: "image/png",
			type: "file",
			url: agentGeneratedReferenceUrl,
		},
	],
	role: "assistant",
};

function Story() {
	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-[980px] space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
						Rich chat content proof
					</p>
					<h1 className="font-semibold text-2xl tracking-tight">
						Attachments, images, tables, and diagrams in one transcript
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm leading-6">
						The transcript uses the shared Desktop chat renderer. File parts
						keep their colored workspace icons, images open the shared zoomable
						lightbox, and dense content can use the extra horizontal room it
						needs.
					</p>
				</header>
				<section
					className="h-[760px] min-h-0 overflow-hidden rounded-3xl border border-border/70 bg-background shadow-sm"
					data-testid="rich-chat-proof"
				>
					<ChatDisplayPrefs>
						<AgentChat
							attachments={{
								files: [
									{
										filename: "Startup Runway v2.0.pdf",
										id: "composer-pdf",
									},
								],
								images: USER_IMAGES.map((image, index) => ({
									filename: image.filename,
									id: `composer-image-${index}`,
									mimeType: "image/png",
									url: image.url,
								})),
							}}
							conversationKey="rich-content-proof"
							currentUser={{ id: "me", name: "You" }}
							emptyStatePosition="center"
							messages={[USER_MESSAGE, ASSISTANT_MESSAGE]}
							onBranch={() => undefined}
							onEditMessage={() => undefined}
							onSend={() => undefined}
							onStop={() => undefined}
							status="ready"
						/>
					</ChatDisplayPrefs>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
