import {
	File01Icon,
	FloppyDiskIcon,
	Message01Icon,
	PresentationBarChart01Icon,
	Xls01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	addContentSlide,
	addTitleSlide,
	createPresentation,
	savePresentation,
} from "@office-kit/pptx";
import { workbookToBytes } from "@office-kit/xlsx/io";
import { addWorksheet, createWorkbook } from "@office-kit/xlsx/workbook";
import { setCell } from "@office-kit/xlsx/worksheet";
import { ChannelsView } from "@ryu/blocks/desktop/channels.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileEditorHandle } from "../../src/components/files/DocxEditor.tsx";
import { SlidesEditor } from "../../src/components/files/SlidesEditor.tsx";
import { SpreadsheetEditor } from "../../src/components/files/SpreadsheetEditor.tsx";
import "../../src/index.css";

type ProofTab = "docx" | "pdf" | "pptx" | "whatsapp" | "xlsx";

const TABS: ReadonlyArray<{
	id: ProofTab;
	label: string;
	icon: IconSvgElement;
}> = [
	{ id: "pdf", label: "Policy.pdf", icon: File01Icon },
	{
		id: "pptx",
		label: "Quarterly review.pptx",
		icon: PresentationBarChart01Icon,
	},
	{ id: "xlsx", label: "Budget.xlsx", icon: Xls01Icon },
	{ id: "docx", label: "Proposal.docx", icon: File01Icon },
	{ id: "whatsapp", label: "WhatsApp", icon: Message01Icon },
];

async function makeSlides(): Promise<ArrayBuffer> {
	const deck = createPresentation();
	addTitleSlide(deck, "Quarterly product review");
	addContentSlide(deck, {
		body: "Native workspace files\nFast editing and explicit save\nWhatsApp beside the work",
		title: "One connected workspace",
	});
	addContentSlide(deck, {
		body: "PDF viewing\nDOCX editing\nXLSX editing\nPPTX editing",
		title: "Built-in file support",
	});
	return Uint8Array.from(await savePresentation(deck)).buffer;
}

async function makeSpreadsheet(): Promise<ArrayBuffer> {
	const workbook = createWorkbook();
	const sheet = addWorksheet(workbook, "FY27 Plan");
	setCell(sheet, 1, 1, "Category");
	setCell(sheet, 1, 2, "Q1");
	setCell(sheet, 1, 3, "Q2");
	setCell(sheet, 2, 1, "Revenue");
	setCell(sheet, 2, 2, 420_000);
	setCell(sheet, 2, 3, 515_000);
	setCell(sheet, 3, 1, "Product");
	setCell(sheet, 3, 2, 145_000);
	setCell(sheet, 3, 3, 168_000);
	return Uint8Array.from(await workbookToBytes(workbook)).buffer;
}

function StaticFilePreview({ kind }: { kind: "docx" | "pdf" }) {
	return (
		<div className="grid h-full place-items-center overflow-auto bg-muted/30 p-10">
			<article className="min-h-[620px] w-full max-w-[780px] rounded-sm bg-space-paper p-16 text-space-paper-foreground shadow-2xl">
				<p className="text-space-paper-foreground/60 text-xs uppercase tracking-section">
					{kind === "pdf" ? "PDF viewer" : "Word document editor"}
				</p>
				<h1 className="mt-8 font-semibold text-4xl tracking-tight">
					{kind === "pdf" ? "Workspace policy" : "Project proposal"}
				</h1>
				<p className="mt-6 text-base text-space-paper-foreground/75 leading-7">
					Files stay inside their Space and open beside chats, apps and other
					work. PDFs render as documents; Word files use the native rich-text
					editor and save back to the same Space.
				</p>
				<div className="mt-10 grid gap-4">
					{[
						"Open in a workspace tab",
						"Edit without leaving Ryu",
						"Save explicitly to the Space",
					].map((item, index) => (
						<div
							className="flex gap-4 border-space-paper-border border-t py-4"
							key={item}
						>
							<span className="text-sm text-space-paper-foreground/60">
								0{index + 1}
							</span>
							<span className="font-medium">{item}</span>
						</div>
					))}
				</div>
			</article>
		</div>
	);
}

function OfficeWorkspaceProof() {
	const [active, setActive] = useState<ProofTab>("pptx");
	const [slides, setSlides] = useState<ArrayBuffer | null>(null);
	const [spreadsheet, setSpreadsheet] = useState<ArrayBuffer | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saveStatus, setSaveStatus] = useState("Saved to Space");
	const editorRef = useRef<FileEditorHandle>(null);
	const handleLoadError = useCallback(
		(message: string) => setSaveStatus(message),
		[]
	);

	useEffect(() => {
		Promise.all([makeSlides(), makeSpreadsheet()]).then(
			([slideBytes, spreadsheetBytes]) => {
				setSlides(slideBytes);
				setSpreadsheet(spreadsheetBytes);
			}
		);
	}, []);

	const save = async () => {
		const output = await editorRef.current?.exportFile();
		if (!output) {
			return;
		}
		setDirty(false);
		setSaveStatus(
			`Saved ${Math.max(1, Math.round(output.size / 1024))} KB to Space`
		);
	};

	return (
		<main
			className="dark h-screen overflow-hidden bg-background text-foreground"
			data-testid="office-workspace-proof"
		>
			<header className="flex h-12 items-end border-white/10 border-b bg-background px-2">
				<div className="mr-3 mb-1 flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground text-xs">
					<span className="grid size-5 place-items-center rounded-md bg-primary/20 text-primary">
						R
					</span>
					Workspace
				</div>
				<nav
					aria-label="Workspace tabs"
					className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
				>
					{TABS.map((tab) => {
						return (
							<button
								aria-current={active === tab.id ? "page" : undefined}
								className={`flex h-9 max-w-52 shrink-0 items-center gap-2 rounded-t-lg px-3 text-xs transition-colors ${
									active === tab.id
										? "border-white/10 border-x border-t bg-background text-foreground"
										: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
								}`}
								data-testid={`workspace-tab-${tab.id}`}
								key={tab.id}
								onClick={() => {
									setActive(tab.id);
									setDirty(false);
									setSaveStatus("Saved to Space");
								}}
								type="button"
							>
								<HugeiconsIcon
									aria-hidden
									className="size-3.5 shrink-0"
									icon={tab.icon}
								/>
								<span className="truncate">{tab.label}</span>
							</button>
						);
					})}
				</nav>
			</header>
			<section className="flex h-[calc(100vh-3rem)] min-h-0 flex-col">
				{active === "whatsapp" ? (
					<ChannelsView
						agents={[{ id: "agent-product", name: "Product teammate" }]}
						authed
						channels={[]}
						initialChannelType="whatsapp"
						initialNew
						onSave={() => true}
						teams={[{ id: "team-support", name: "Support team" }]}
					/>
				) : (
					<>
						<div className="flex h-12 shrink-0 items-center gap-3 border-white/10 border-b px-4">
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">
									{TABS.find((tab) => tab.id === active)?.label}
								</p>
								<p className="text-muted-foreground text-xs">
									{dirty ? "Unsaved changes" : saveStatus}
								</p>
							</div>
							{active === "pptx" || active === "xlsx" ? (
								<Button disabled={!dirty} onClick={save} size="sm">
									<HugeiconsIcon icon={FloppyDiskIcon} /> Save
								</Button>
							) : null}
						</div>
						{active === "pptx" && slides ? (
							<SlidesEditor
								bytes={slides}
								mime="application/vnd.openxmlformats-officedocument.presentationml.presentation"
								onDirty={() => setDirty(true)}
								onLoadError={handleLoadError}
								ref={editorRef}
							/>
						) : null}
						{active === "xlsx" && spreadsheet ? (
							<SpreadsheetEditor
								bytes={spreadsheet}
								mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
								onDirty={() => setDirty(true)}
								onLoadError={handleLoadError}
								ref={editorRef}
							/>
						) : null}
						{active === "pdf" ? <StaticFilePreview kind="pdf" /> : null}
						{active === "docx" ? <StaticFilePreview kind="docx" /> : null}
					</>
				)}
			</section>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<OfficeWorkspaceProof />);
