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
import { type SubmitEvent, useEffect, useId, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { Space } from "@/src/lib/api/spaces.ts";

/** Rename a user-created Space without leaving the sidebar. */
export function RenameSpaceDialog({
	onClose,
	onRename,
	open,
	space,
}: {
	onClose: () => void;
	onRename: (name: string) => Promise<void>;
	open: boolean;
	space: Space;
}) {
	const inputId = useId();
	const [name, setName] = useState(space.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName(space.name);
			setError(null);
		}
	}, [open, space.name]);

	const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextName = name.trim();
		if (!nextName) {
			setError("Enter a name for this space.");
			return;
		}

		setBusy(true);
		setError(null);
		try {
			await onRename(nextName);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to rename space");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!(next || busy)) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Rename space</DialogTitle>
						<DialogDescription>
							Choose a new name for <strong>{space.name}</strong>.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5 py-4">
						<Label htmlFor={inputId}>Name</Label>
						<Input
							autoFocus
							disabled={busy}
							id={inputId}
							onChange={(event) => setName(event.target.value)}
							value={name}
						/>
						{error ? <ErrorLine message={error} /> : null}
					</div>
					<DialogFooter>
						<Button
							disabled={busy}
							onClick={onClose}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={!name.trim()} loading={busy} type="submit">
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
