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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type SubmitEvent, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { createProject, type ProjectRecord } from "@/src/lib/api/hierarchy.ts";
import {
	buildFirstProjectInput,
	FIRST_PROJECT_ABOUT_MAX,
	FIRST_PROJECT_NAME_MAX,
	firstProjectError,
} from "@/src/lib/first-project.ts";

/**
 * Create a project from the sidebar's Projects section. The project is created
 * on the active node by the Projects app, with the default agent coordinating
 * it; the caller opens its main thread.
 */
export function CreateProjectDialog({
	onCreated,
	onOpenChange,
	open,
	target,
}: {
	onCreated: (project: ProjectRecord) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [name, setName] = useState("");
	const [about, setAbout] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const draft = { about, folder: null, icon: null, name };
	const validation = firstProjectError(draft);

	const reset = () => {
		setName("");
		setAbout("");
		setError(null);
	};

	const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (validation || submitting) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const project = await createProject(
				target,
				buildFirstProjectInput(draft, "ryu")
			);
			reset();
			onOpenChange(false);
			onCreated(project);
		} catch (cause) {
			setError(
				cause instanceof Error
					? tl("Couldn't create the project: {message}", {
							message: cause.message,
						})
					: "Couldn't create the project. Check that the Projects app is enabled."
			);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					reset();
				}
				onOpenChange(next);
			}}
			open={open}
		>
			<DialogContent>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => void handleSubmit(event)}
				>
					<DialogHeader>
						<DialogTitle>New project</DialogTitle>
						<DialogDescription>
							A project has its own coordinator thread, the bots and groups
							working on it, and shared context.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-project-name">Project name</Label>
						<Input
							autoComplete="off"
							autoFocus
							id="new-project-name"
							maxLength={FIRST_PROJECT_NAME_MAX}
							onChange={(event) => setName(event.target.value)}
							value={name}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-project-about">
							What is this project about?{" "}
							<span className="text-muted-foreground">(optional)</span>
						</Label>
						<Textarea
							id="new-project-about"
							maxLength={FIRST_PROJECT_ABOUT_MAX}
							onChange={(event) => setAbout(event.target.value)}
							rows={3}
							value={about}
						/>
					</div>
					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							disabled={submitting}
							onClick={() => onOpenChange(false)}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={Boolean(validation) || submitting} type="submit">
							{submitting ? "Creating…" : "Create project"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
