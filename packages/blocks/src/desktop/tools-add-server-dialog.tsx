"use client";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ChangeEvent, useState } from "react";
import type { CreateServerInput, CreateServerResult } from "./tools-types.ts";

export function AddServerDialog({
	onCreateServer,
}: {
	onCreateServer?: (input: CreateServerInput) => Promise<CreateServerResult>;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [argsText, setArgsText] = useState("");
	const [description, setDescription] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const reset = () => {
		setName("");
		setCommand("");
		setArgsText("");
		setDescription("");
		setFormError(null);
	};

	const handleSubmit = async () => {
		setFormError(null);

		const trimmedName = name.trim();
		const trimmedCommand = command.trim();

		if (!trimmedName) {
			setFormError("Name is required.");
			return;
		}
		if (trimmedName.includes("__")) {
			setFormError("Name must not contain '__' (reserved legacy separator).");
			return;
		}
		if (!trimmedCommand) {
			setFormError("Command is required.");
			return;
		}

		const args = argsText
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);

		setSubmitting(true);
		try {
			const result = await onCreateServer?.({
				name: trimmedName,
				command: trimmedCommand,
				args,
				description: description.trim() || undefined,
			});
			if (result?.ok) {
				reset();
				setOpen(false);
			} else {
				setFormError(result?.error ?? "Failed to add server.");
			}
		} catch (e) {
			setFormError(e instanceof Error ? e.message : "Failed to add server.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					reset();
				}
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" variant="ghost" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add server
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add MCP server</DialogTitle>
					<DialogDescription>
						Register a new MCP server. The entry is saved to{" "}
						<code className="text-xs">~/.ryu/mcp.json</code> and takes effect
						immediately, no restart required.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-name">Name</Label>
						<Input
							id="mcp-name"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setName(e.target.value)
							}
							placeholder="e.g. filesystem"
							value={name}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-command">Command</Label>
						<Input
							id="mcp-command"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setCommand(e.target.value)
							}
							placeholder="e.g. npx"
							value={command}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-args">
							Arguments{" "}
							<span className="text-muted-foreground text-xs">
								(space-separated)
							</span>
						</Label>
						<Input
							id="mcp-args"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setArgsText(e.target.value)
							}
							placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
							value={argsText}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-description">
							Description{" "}
							<span className="text-muted-foreground text-xs">(optional)</span>
						</Label>
						<Textarea
							id="mcp-description"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setDescription(e.target.value)
							}
							placeholder="What does this server do?"
							rows={2}
							value={description}
						/>
					</div>

					{formError ? (
						<p className="text-sm text-status-destructive">{formError}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						disabled={submitting}
						onClick={() => {
							setOpen(false);
							reset();
						}}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={submitting} onClick={handleSubmit} type="button">
						Add server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
