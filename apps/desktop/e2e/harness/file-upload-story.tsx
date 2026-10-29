// Standalone browser story for the REAL FileUpload — the dropzone + queue behind
// the Spaces "Add to space" dialog.
//
// Every row state is rendered at once because they are what the component exists
// to distinguish, and three of them are easy to get wrong without looking:
// a DETERMINATE bar (a real `onprogress` fraction), an INDETERMINATE one
// (`progress: null` — in flight, fraction not yet known), and a `success` row whose
// note says the file stored but its contents could NOT be indexed. That last one is
// the whole reason the dialog reads Core's `index.state` instead of trusting the
// 200, so it has to be visibly different from a plain "stored and searchable".

import {
	FileUpload,
	type FileUploadItem,
} from "@ryu/ui/components/file-upload.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const ITEMS: FileUploadItem[] = [
	{
		id: "queued",
		name: "quarterly-plan.docx",
		size: 1_140_000,
		status: "pending",
	},
	{
		id: "determinate",
		name: "release-cut.mov",
		progress: 0.62,
		size: 84_200_000,
		status: "uploading",
	},
	{
		id: "indeterminate",
		name: "brand-assets.zip",
		progress: null,
		size: 18_400_000,
		status: "uploading",
	},
	{
		id: "indexed",
		name: "notes.md",
		note: "Stored and searchable",
		progress: 1,
		size: 4200,
		status: "success",
	},
	{
		id: "skipped",
		name: "scanned-contract.pdf",
		note: "Stored — nothing on this node can read this format, so its contents aren't searchable",
		progress: 1,
		size: 9_800_000,
		status: "success",
	},
	{
		id: "failed",
		name: "keynote-deck.key",
		error: "Too large — the limit is 32 MB.",
		size: 220_400_000,
		status: "error",
	},
];

function Column({ dark, label }: { dark: boolean; label: string }) {
	return (
		<div
			className={`${dark ? "dark" : ""} flex-1 bg-background p-8 text-foreground`}
		>
			<p className="mb-6 font-medium text-muted-foreground text-xs uppercase tracking-widest">
				{label}
			</p>
			<div className="w-[26rem]">
				<FileUpload
					items={ITEMS}
					onFilesAdded={() => undefined}
					onRemove={() => undefined}
					onRetry={() => undefined}
				/>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<div className="flex min-h-screen">
		<Column dark={false} label="Light" />
		<Column dark label="Dark" />
	</div>
);
