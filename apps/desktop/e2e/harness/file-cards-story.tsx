// Story for the transcript file cards (`e2e/file-cards-story.spec.ts`).
//
// It draws what the chat draws, through the same components and the same
// artifact host contract, with a host that serves bytes from memory:
//   1. The file card in each state: ready, downloading, downloaded, failed,
//      unavailable, plus a very long name, a right-to-left name, and a title
//      that is a path.
//   2. An inline attachment (`file` part with a data URL).
//   3. Files made with `artifact.create`, routed through the real
//      `InlineArtifact` renderer: an image and a PDF with an inline preview,
//      and an office file with Download and Open.
//   4. The artifact card with its Download button.
// Downloads are real browser downloads, so the spec reads the suggested file
// name and the saved bytes.
//
// `?before=1` draws the same parts the way the transcript drew them before
// the file card, for the before screenshots: the attachment through the old
// chip rule, and the created files through the artifact card, which read
// every created file as text and had no Download button.
// `?theme=dark` paints the dark tokens from the first frame.

import {
	ArtifactHostContext,
	type ArtifactHostValue,
	type HostArtifact,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { AssistantFileCard } from "@ryu/blocks/desktop/agent-elements/assistant-file-card.tsx";
import { assistantFileCardMeta } from "@ryu/blocks/desktop/agent-elements/assistant-file-meta.ts";
import { FileCard } from "@ryu/blocks/desktop/agent-elements/file-card.tsx";
import { FileAttachment } from "@ryu/blocks/desktop/agent-elements/input/file-attachment.tsx";
import { getAssistantFileMeta } from "@ryu/blocks/desktop/agent-elements/utils/live-file-media.ts";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	InlineArtifact,
	InlineContentArtifact,
} from "../../src/components/chat/InlineArtifact.tsx";
import "../../src/index.css";

const BEFORE =
	new URLSearchParams(window.location.search).get("before") === "1";
/** The before page hides the button the artifact card did not have. */
const HIDE_DOWNLOAD = '[data-testid="artifact-download"]{display:none}';

const SPACE_ID = "0b6f8f0e-0d0c-4c57-9a55-5f2f3a8f4c11";
const IMAGE_DOC = "11111111-1111-4111-8111-111111111111";
const PDF_DOC = "22222222-2222-4222-8222-222222222222";
const DOCX_DOC = "33333333-3333-4333-8333-333333333333";
const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function created(docId: string, fields: HostArtifact): HostArtifact {
	return {
		docId,
		spaceId: SPACE_ID,
		url: `/api/spaces/${SPACE_ID}/documents/${docId}/blob`,
		...fields,
	};
}

const IMAGE_ARTIFACT = created(IMAGE_DOC, {
	byteSize: 18_432,
	mime: "image/png",
	title: "Weekly signups.png",
});
const PDF_ARTIFACT = created(PDF_DOC, {
	byteSize: 612,
	mime: "application/pdf",
	title: "Quarterly report.pdf",
});
const DOCX_ARTIFACT = created(DOCX_DOC, {
	byteSize: 48_213,
	mime: DOCX_MIME,
	title: "Offer letter.docx",
});
const PAGE_ARTIFACT: HostArtifact = {
	content:
		"<div style='padding:16px;font:14px system-ui'><b>Signup funnel</b><br>Visits 1,204 · Signups 311 · Paid 48</div>",
	kind: "html",
	title: "Signup funnel",
};

// The `file` part an agent runtime sends for an attached file. The bytes are
// "a,b\n1,2" in base64.
const CSV_PART = {
	filename: "numbers.csv",
	mediaType: "text/csv",
	type: "file",
	url: "data:text/csv;base64,YSxiCjEsMg==",
};

/** A one-page PDF with one line of text, with a correct cross-reference table. */
function onePagePdf(line: string): Blob {
	const content = `BT /F1 22 Tf 36 230 Td (${line}) Tj ET\n0 0 0 rg 36 60 348 120 re f`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefStart = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return new Blob([body], { type: "application/pdf" });
}

/** A small bar chart drawn on a canvas, as PNG bytes. */
function chartPng(): Promise<Blob | null> {
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 320;
	const context = canvas.getContext("2d");
	if (!context) {
		return Promise.resolve(null);
	}
	context.fillStyle = "#f8fafc";
	context.fillRect(0, 0, canvas.width, canvas.height);
	const bars = [120, 180, 150, 230, 210, 260, 290];
	for (const [index, height] of bars.entries()) {
		context.fillStyle = index === bars.length - 1 ? "#2563eb" : "#93c5fd";
		context.fillRect(40 + index * 84, 300 - height, 56, height);
	}
	return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function storedBytes(docId: string): Promise<Blob | null> {
	if (docId === IMAGE_DOC) {
		return chartPng();
	}
	if (docId === PDF_DOC) {
		return Promise.resolve(onePagePdf("Quarterly report"));
	}
	if (docId === DOCX_DOC) {
		return Promise.resolve(new Blob(["PK story docx"], { type: DOCX_MIME }));
	}
	return Promise.resolve(null);
}

function Pane({
	children,
	dir,
	id,
	title,
}: {
	children: ReactNode;
	dir?: "rtl";
	id: string;
	title: string;
}) {
	return (
		<section className="space-y-2" data-testid={`story-${id}`} dir={dir}>
			<h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
				{title}
			</h2>
			{children}
		</section>
	);
}

const smallPdf = () => Promise.resolve(onePagePdf("Board report"));
const neverAnswers = () => new Promise<Blob | null>(() => undefined);
const noBytes = () => Promise.resolve(null);
const plainText = () =>
	Promise.resolve(new Blob(["ssh-ed25519 story"], { type: "text/plain" }));

/** The attachment as the transcript draws it now: the file card. */
function AttachmentNow() {
	const file = assistantFileCardMeta(CSV_PART);
	return file ? (
		<AssistantFileCard file={file} id="story-message-file-0" />
	) : null;
}

/** The attachment as the transcript drew it before: the chip, and only when
 *  the old rule admitted the part's URL. Otherwise the part drew nothing. */
function AttachmentBefore() {
	const file = getAssistantFileMeta(CSV_PART);
	return file ? (
		<FileAttachment
			filename={file.filename}
			id="story-message-file-0"
			size={file.size}
			url={file.url}
		/>
	) : (
		<p className="text-muted-foreground text-sm" data-testid="before-nothing">
			Nothing was drawn for this part.
		</p>
	);
}

/** The created files and the artifact card as they were before: every created
 *  file went through the artifact card, and the card had no Download. */
function BeforeArtifacts() {
	return (
		<>
			<style>{HIDE_DOWNLOAD}</style>
			<Pane id="attachment" title="Inline attachment">
				<AttachmentBefore />
			</Pane>
			<Pane id="image" title="Created image">
				<InlineContentArtifact artifact={IMAGE_ARTIFACT} id="artifact-image" />
			</Pane>
			<Pane id="pdf" title="Created PDF">
				<InlineContentArtifact artifact={PDF_ARTIFACT} id="artifact-pdf" />
			</Pane>
			<Pane id="office" title="Created office file">
				<InlineContentArtifact artifact={DOCX_ARTIFACT} id="artifact-docx" />
			</Pane>
			<Pane id="artifact" title="Artifact card">
				<InlineContentArtifact artifact={PAGE_ARTIFACT} id="artifact-page" />
			</Pane>
		</>
	);
}

/** The files and the artifact card as the transcript draws them now. */
function NowArtifacts() {
	return (
		<>
			<Pane id="attachment" title="Inline attachment">
				<AttachmentNow />
			</Pane>
			<Pane id="image" title="Created image, with preview">
				<InlineArtifact artifact={IMAGE_ARTIFACT} id="artifact-image" />
			</Pane>
			<Pane id="pdf" title="Created PDF, with preview">
				<InlineArtifact artifact={PDF_ARTIFACT} id="artifact-pdf" />
			</Pane>
			<Pane id="office" title="Created office file">
				<InlineArtifact artifact={DOCX_ARTIFACT} id="artifact-docx" />
			</Pane>
			<Pane id="artifact" title="Artifact card with Download">
				<InlineArtifact artifact={PAGE_ARTIFACT} id="artifact-page" />
			</Pane>
		</>
	);
}

/** The file card in each of its states. */
function CardStates({ note }: { note: (line: string) => void }) {
	return (
		<>
			<Pane id="ready" title="Ready">
				<FileCard
					loadBlob={smallPdf}
					mime="application/pdf"
					name="Q3 board report.pdf"
					onOpen={() => note("open Q3 board report")}
					size={1_258_291}
				/>
			</Pane>
			<Pane id="downloading" title="Downloading">
				<FileCard
					loadBlob={neverAnswers}
					mime="application/zip"
					name="site-export.zip"
					size={48_234_112}
				/>
			</Pane>
			<Pane id="downloaded" title="Downloaded">
				<FileCard
					loadBlob={smallPdf}
					mime="application/pdf"
					name="Invoice 2026-11.pdf"
					size={84_480}
				/>
			</Pane>
			<Pane id="failed" title="Failed, with Retry">
				<FileCard
					loadBlob={noBytes}
					mime="text/csv"
					name="customers.csv"
					size={2048}
				/>
			</Pane>
			<Pane id="unavailable" title="Unavailable">
				<FileCard
					mime="application/zip"
					name="old-backup.zip"
					size={7_340_032}
				/>
			</Pane>
			<Pane id="long-name" title="A very long name">
				<FileCard
					loadBlob={smallPdf}
					mime="application/pdf"
					name="2026-11-19_quarterly-board-report_final_v7_reviewed-by-finance-and-legal_signed-copy_do-not-share.pdf"
					onOpen={() => undefined}
					size={5_242_880}
				/>
			</Pane>
			<Pane dir="rtl" id="rtl" title="Right to left">
				<FileCard
					loadBlob={smallPdf}
					mime="application/pdf"
					name="تقرير الربع الثالث.pdf"
					onOpen={() => undefined}
					size={312_320}
				/>
			</Pane>
			<Pane id="path-title" title="A title that is a path">
				<FileCard
					loadBlob={plainText}
					mime="text/plain"
					name="..\..\.ssh/authorized_keys"
					size={17}
				/>
			</Pane>
		</>
	);
}

function Story() {
	const [log, setLog] = useState<string[]>([]);
	const note = useCallback(
		(line: string) => setLog((lines) => [...lines, line]),
		[]
	);
	const host = useMemo<ArtifactHostValue>(() => {
		const text = (value: unknown) => (typeof value === "string" ? value : "");
		return {
			fetchBlob: (payload) => storedBytes(text(payload.docId)),
			// Before the file card, the app's host read every created file as text.
			fetchContent: async (payload) => {
				const blob = BEFORE ? await storedBytes(text(payload.docId)) : null;
				return blob ? await blob.text() : null;
			},
			openFile: (payload) => note(`openFile ${text(payload.title)}`),
			openInPanel: (payload) => note(`openInPanel ${text(payload.title)}`),
			openInTab: (payload) => note(`openInTab ${text(payload.title)}`),
			Renderer: InlineArtifact,
			submitFollowUp: () => undefined,
		};
	}, [note]);

	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-2xl space-y-6">
				<header className="space-y-1">
					<h1
						className="font-semibold text-2xl tracking-tight"
						data-testid="story-mode"
					>
						{BEFORE ? "Files in the chat, before" : "File cards"}
					</h1>
					<p className="text-muted-foreground text-sm">
						Files the agent created or attached, as the transcript draws them.
					</p>
				</header>

				{BEFORE ? null : <CardStates note={note} />}

				<ArtifactHostContext.Provider value={host}>
					{BEFORE ? <BeforeArtifacts /> : <NowArtifacts />}
				</ArtifactHostContext.Provider>

				<pre
					className="rounded-lg border bg-muted p-3 text-xs"
					data-testid="story-log"
				>
					{log.join("\n")}
				</pre>
			</div>
		</main>
	);
}

// The dark tokens go on before the first frame, so a screenshot never catches
// a colour transition half way.
if (new URLSearchParams(window.location.search).get("theme") === "dark") {
	document.documentElement.classList.add("dark");
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
