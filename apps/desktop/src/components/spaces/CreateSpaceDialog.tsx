import {
	RetrievalModeChoice,
	retrievalModeLabel,
	type SpaceRetrievalMode,
	type SpaceVisibility,
	SpaceVisibilityChoice,
} from "@ryu/blocks/desktop/spaces.tsx";
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
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import { type ChangeEvent, type SubmitEvent, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";

/**
 * What the picker shows before the user touches it. `"vector"` is Core's shipped
 * default (`DEFAULT_RAG_STRATEGY` in `apps/core/src/registry/mod.rs`), so this is
 * right on every node an operator has not reconfigured. For the node that HAS
 * been reconfigured, `handleSubmit` compares this against the mode Core echoes
 * back and says so rather than leaving a wrong impression standing.
 */
const DEFAULT_MODE: SpaceRetrievalMode = "vector";

/**
 * The dialog's own copy is plain already ("A space is a named collection of
 * documents you can search"), so the only jargon it can leak is the mode name —
 * and it leaks it through the toast below, not through the picker, which names
 * the modes itself. `retrievalModeLabel` is the same shared table the picker
 * reads, so a toast fired while friendly names are on says "Created with
 * Connected search retrieval" rather than naming an algorithm the user was never
 * shown.
 */

/**
 * Create-a-space dialog, shared by the Spaces page and the sidebar's Spaces
 * section so both surfaces open the same form (and the same `create` from the
 * shared `SpacesProvider`).
 */
export function CreateSpaceDialog({
	open,
	onClose,
	onCreate,
}: {
	open: boolean;
	onClose: () => void;
	/**
	 * Resolves to the retrieval mode Core actually stamped on the new Space, or
	 * `null` when nothing was created (the managed-tier cap blocked it).
	 */
	onCreate: (
		name: string,
		description: string | null,
		retrievalMode?: SpaceRetrievalMode,
		visibility?: SpaceVisibility
	) => Promise<SpaceRetrievalMode | null>;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	// `null` = the user never touched the picker, which is NOT the same as picking
	// Vector. Only an explicit pick is sent, because an omitted field is what lets
	// the node-wide `rag_strategy` default still apply; always transmitting the
	// displayed value would make that operator setting unreachable from here.
	const [mode, setMode] = useState<SpaceRetrievalMode | null>(null);
	const [visibility, setVisibility] = useState<SpaceVisibility>("private");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [friendly] = useFriendlyMode();
	const tl = useLiteralMessages();

	const reset = () => {
		setName("");
		setDescription("");
		setMode(null);
		setVisibility("private");
		setError(null);
	};

	const handleSubmit = async (e: SubmitEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const created = await onCreate(
				name.trim(),
				description.trim() || null,
				mode ?? undefined,
				visibility
			);
			// The picker showed `mode ?? DEFAULT_MODE`. On a node whose operator set
			// `rag_strategy` to something else, an untouched picker produces a Space
			// in a mode the dialog did not show — so say so instead of leaving the
			// user with a wrong belief about the Space they just made.
			const shown = mode ?? DEFAULT_MODE;
			if (created !== null && created !== shown) {
				const retrievalMode = retrievalModeLabel(created, friendly);
				toast.info({
					// A fixed slot id: repeated creates on such a node should replace
					// this notice, not stack identical copies of it.
					id: "space-retrieval-mode-default",
					title: tl("Created with {retrievalMode} retrieval", {
						retrievalMode,
					}),
					description: tl(
						"This node's default retrieval mode is {retrievalMode}. You can change it in the space's Retrieval settings.",
						{ retrievalMode }
					),
				});
			}
			reset();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create space");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					reset();
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>New space</DialogTitle>
						<DialogDescription>
							A space is a named collection of documents you can search.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-4 py-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="space-name">Name</Label>
							<Input
								id="space-name"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setName(e.target.value)
								}
								placeholder="e.g. Product docs"
								value={name}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="space-description">Description (optional)</Label>
							<Input
								id="space-description"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setDescription(e.target.value)
								}
								placeholder="What's in this space?"
								value={description}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<Label>Visibility</Label>
							<SpaceVisibilityChoice
								disabled={busy}
								idPrefix="new-space-visibility"
								onVisibilityChange={setVisibility}
								visibility={visibility}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<Label>Retrieval</Label>
							<RetrievalModeChoice
								disabled={busy}
								idPrefix="new-space-retrieval-mode"
								mode={mode ?? DEFAULT_MODE}
								onModeChange={setMode}
							/>
						</div>
						{error ? <ErrorLine message={error} /> : null}
					</div>
					<DialogFooter>
						<Button
							onClick={() => {
								reset();
								onClose();
							}}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={!name.trim()} loading={busy} type="submit">
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
