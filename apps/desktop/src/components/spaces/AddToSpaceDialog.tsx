// apps/desktop/src/components/spaces/AddToSpaceDialog.tsx
//
// "Add to <space>" — the dialog behind the sidebar row's hover "+" and the create
// menu's "Upload files" row. One surface for the three ways something enters a
// Space: upload a file, start a page, start a database.
//
// ## Why the upload half reports an outcome and not just a tick
//
// `POST /api/spaces/:id/files` stores the bytes AND runs extraction, then reports
// what extraction managed in `index`. A 200 therefore means "stored", not
// "searchable" — a scanned PDF on a node with no OCR reader comes back `skipped`,
// and a user told "Uploaded ✓" would go on to search for text that was never
// indexed. Every finished row prints the extraction outcome for that reason.
//
// Uploads run one at a time. The wire form is base64 JSON at up to 32 MiB a file,
// so N concurrent uploads means N inflated copies resident at once; serialising
// costs wall-clock on a big batch and bounds memory, which is the better trade for
// a dialog someone drags a folder into.

import { Database01Icon, StickyNote01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { FileUpload } from "@ryu/ui/components/file-upload.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useMemo, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useSpaceFileUpload } from "@/src/hooks/useSpaceFileUpload.ts";

/** The system space every other upload path in the app already writes to, and so
 *  the least surprising default when the dialog is opened without a target. */
const DEFAULT_SPACE_NAME = "Uploads";

export function AddToSpaceDialog({
	onClose,
	open,
	spaceId,
}: {
	onClose: () => void;
	open: boolean;
	/** The Space to add to. `null` opens the dialog with a picker instead — the
	 *  create-menu entry point, which has no row to infer a target from. */
	spaceId: string | null;
}) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const { spaces, createPage, createDatabase } = useSpacesContext();
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const fallbackId = useMemo(() => {
		const uploads = spaces.find(
			(s) => s.name.toLowerCase() === DEFAULT_SPACE_NAME.toLowerCase()
		);
		return uploads?.id ?? spaces[0]?.id ?? null;
	}, [spaces]);

	const targetId = spaceId ?? pickedId ?? fallbackId;
	const target = spaces.find((s) => s.id === targetId) ?? null;
	const { onFilesAdded, onRemove, onRetry, queue, reset, uploading } =
		useSpaceFileUpload(targetId);

	// A fresh open starts from an empty queue: leaving the previous batch's rows up
	// would show results for a Space the user may no longer be looking at.
	useEffect(() => {
		if (open) {
			reset();
			setPickedId(null);
		}
	}, [open, reset]);

	const createAndOpen = async (kind: "database" | "page") => {
		if (!targetId) {
			return;
		}
		setCreating(true);
		try {
			const id =
				kind === "page"
					? await createPage(targetId, "Untitled")
					: await createDatabase(targetId, "Untitled");
			openTab(`/spaces/${targetId}/${kind === "page" ? "doc" : "db"}/${id}`, {
				title: "Untitled",
			});
			onClose();
		} catch {
			toast.error(
				kind === "page"
					? "Couldn't create the page"
					: "Couldn't create the database"
			);
		} finally {
			setCreating(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{target
							? tl("Add to {spaceName}", { spaceName: target.name })
							: "Add to a space"}
					</DialogTitle>
					<DialogDescription>
						Upload files, or start a new page or database in this space.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-4">
					{spaceId === null && (
						<div className="flex flex-col gap-1.5">
							<Label>Space</Label>
							<Select
								items={spaces.map((s) => ({ label: s.name, value: s.id }))}
								onValueChange={(value) => {
									if (value !== null) {
										setPickedId(value);
									}
								}}
								value={targetId ?? ""}
							>
								<SelectTrigger className="h-9 w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{spaces.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
					<FileUpload
						description="Files are read and indexed by this node"
						disabled={!targetId}
						items={queue}
						onFilesAdded={onFilesAdded}
						onRemove={onRemove}
						onRetry={onRetry}
						title="Drop files here"
					/>
					<div className="flex flex-col gap-2">
						<Label>Or start something new</Label>
						<div className="flex gap-2">
							<Button
								className="flex-1"
								disabled={creating || !targetId}
								onClick={() => {
									void createAndOpen("page");
								}}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={StickyNote01Icon} />
								New page
							</Button>
							<Button
								className="flex-1"
								disabled={creating || !targetId}
								onClick={() => {
									void createAndOpen("database");
								}}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Database01Icon} />
								New database
							</Button>
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button onClick={onClose} type="button" variant="ghost">
						{/* Closing mid-upload does not cancel it — the transfer is owned by
						    the promise chain, not by this dialog's mount. Say so rather than
						    implying a cancel this button does not perform. */}
						{uploading ? "Close (uploads continue)" : "Done"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
