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
import { useEffect, useRef, useState } from "react";

export function BotChatSectionDialog({
	initialName = "",
	mode,
	onOpenChange,
	onSubmit,
	open,
}: {
	initialName?: string;
	mode: "create" | "rename";
	onOpenChange: (open: boolean) => void;
	onSubmit: (name: string) => void;
	open: boolean;
}) {
	const [name, setName] = useState(initialName);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setName(initialName);
		window.setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 0);
	}, [initialName, open]);

	const trimmedName = name.trim();
	const submit = () => {
		if (!trimmedName) {
			return;
		}
		onSubmit(trimmedName);
		onOpenChange(false);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>
						{mode === "create" ? "New chat section" : "Rename chat section"}
					</DialogTitle>
					<DialogDescription>
						Group related chats together in the Bot view.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<Input
						aria-label="Section name"
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						placeholder="e.g. Client follow-up"
						ref={inputRef}
						value={name}
					/>
					<DialogFooter>
						<Button
							onClick={() => onOpenChange(false)}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={!trimmedName} type="submit">
							{mode === "create" ? "Create section" : "Save name"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
