import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { type ChangeEvent, type FormEvent, useState } from "react";

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
	onCreate: (name: string, description: string | null) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reset = () => {
		setName("");
		setDescription("");
		setError(null);
	};

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onCreate(name.trim(), description.trim() || null);
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
						{error ? <p className="text-destructive text-sm">{error}</p> : null}
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
						<Button disabled={busy || !name.trim()} type="submit">
							{busy ? <Spinner className="size-4" /> : null}
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
