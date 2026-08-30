import type { UIMessage } from "ai";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const agentReferenceUrl = new URL("./agent-reference.svg", window.location.href)
	.href;

function imageData(label: string, start: string, end: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="640" height="420" rx="34" fill="url(#g)"/><circle cx="518" cy="100" r="138" fill="#fff" fill-opacity=".18"/><path d="M74 250c70-96 128-18 190-76 60-56 106 30 176-20 48-34 78-7 126 42" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="10"/><rect x="74" y="70" width="146" height="12" rx="6" fill="#fff" fill-opacity=".55"/><rect x="74" y="104" width="290" height="30" rx="15" fill="#fff" fill-opacity=".94"/><text x="74" y="354" fill="#fff" font-family="Inter, sans-serif" font-size="30" font-weight="700">${label}</text><text x="74" y="384" fill="#fff" fill-opacity=".72" font-family="Inter, sans-serif" font-size="15">Chat attachment preview</text></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const USER_IMAGES = [
	{
		filename: "brief-cover.svg",
		url: imageData("Brief cover", "#172554", "#2563eb"),
	},
	{
		filename: "weekly-template.svg",
		url: imageData("Weekly template", "#3f1d5a", "#a21caf"),
	},
	{
		filename: "runway-map.svg",
		url: imageData("Runway map", "#134e4a", "#0f766e"),
	},
	{
		filename: "launch-notes.svg",
		url: imageData("Launch notes", "#7c2d12", "#ea580c"),
	},
	{
		filename: "review-grid.svg",
		url: imageData("Review grid", "#3b0764", "#7e22ce"),
	},
	{
		filename: "final-slide.svg",
		url: imageData("Final slide", "#164e63", "#0891b2"),
	},
] as const;

const USER_MESSAGE: UIMessage = {
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
		...USER_IMAGES.map((image) => ({
			filename: image.filename,
			mediaType: "image/svg+xml",
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
} as unknown as UIMessage;

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

const ASSISTANT_MESSAGE: UIMessage = {
	createdAt: "2026-08-29T18:53:00.000Z",
	id: "rich-assistant",
	parts: [
		{ text: ASSISTANT_MARKDOWN, type: "text" },
		{
			filename: "agent-reference.svg",
			mediaType: "image/svg+xml",
			type: "file",
			url: imageData("Generated reference", "#172554", "#be123c"),
		},
	],
	role: "assistant",
} as unknown as UIMessage;

function Story() {
	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-[980px] space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-primary text-xs uppercase tracking-[0.18em]">
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
									mimeType: "image/svg+xml",
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
