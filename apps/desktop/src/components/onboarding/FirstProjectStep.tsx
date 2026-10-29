import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphPicker } from "@ryu/ui/components/glyph-picker.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { open } from "@tauri-apps/plugin-dialog";
import { type SubmitEvent, useRef, useState } from "react";
import { getActiveUserId } from "@/lib/auth-client.ts";
import {
	RyuOnboardingAvatar,
	useRyuOnboardingPersona,
} from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import { createProject, type ProjectRecord } from "@/src/lib/api/hierarchy.ts";
import {
	buildFirstProjectInput,
	FIRST_PROJECT_ABOUT_MAX,
	FIRST_PROJECT_NAME_MAX,
	FIRST_PROJECT_SUGGESTION,
	firstProjectError,
} from "@/src/lib/first-project.ts";
import {
	bindOnboardingProjectTarget,
	type OnboardingProjectBinding,
} from "@/src/lib/onboarding-project-persistence.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface FirstProjectStepProps {
	/** The agent personalized on the previous step; it coordinates the project. */
	coordinatorAgentId?: string;
	onCreated: (
		project: ProjectRecord,
		binding: OnboardingProjectBinding
	) => void | Promise<void>;
	onSkip: () => void;
	target: ApiTarget;
}

function errorMessage<TCause>(cause: TCause, tl: LiteralMessage): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return tl("Ryu couldn't create the project: {reason}", {
			reason: cause.serverMessage,
		});
	}
	return cause instanceof Error && cause.message
		? tl("Ryu couldn't create the project: {reason}", {
				reason: cause.message,
			})
		: "Ryu couldn't create the project. Check that this node is running, then retry.";
}

/**
 * Onboarding: "Create your first project". Sits between the default-agent step
 * and the agent picker. A project keeps a goal, its context and the bots working
 * on it together, and the agent the user just named coordinates it — so a new
 * user lands in a project's main thread instead of an empty sidebar.
 *
 * Failure never removes the step: if the Projects app is unreachable the user
 * sees the reason with Retry and Skip, matching the rest of the wizard.
 */
export function FirstProjectStep({
	coordinatorAgentId = "ryu",
	onCreated,
	onSkip,
	target,
}: FirstProjectStepProps) {
	const tl = useLiteralMessages();
	const { name: agentName } = useRyuOnboardingPersona();
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
	const [name, setName] = useState(FIRST_PROJECT_SUGGESTION);
	const [about, setAbout] = useState("");
	const [icon, setIcon] = useState<GlyphValue>(null);
	const [folder, setFolder] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submissionPending = useRef(false);
	const acknowledgedReceipt = useRef<{
		project: ProjectRecord;
		binding: OnboardingProjectBinding;
		folderApplied: boolean;
	} | null>(null);
	const skipPending = useRef(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canPickFolder = isTauriReady();

	const draft = { about, folder, icon, name };
	const validation = firstProjectError(draft);

	const chooseFolder = async () => {
		try {
			const selected = await open({ directory: true, multiple: false });
			if (selected && !Array.isArray(selected)) {
				setFolder(selected);
			}
		} catch {
			setError(
				"The folder picker isn't available here. You can add a folder later."
			);
		}
	};

	const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if ((!skipPending.current && validation) || submissionPending.current) {
			return;
		}
		submissionPending.current = true;
		setSubmitting(true);
		setError(null);
		try {
			if (skipPending.current) {
				onSkip();
				skipPending.current = false;
				return;
			}
			let receipt = acknowledgedReceipt.current;
			if (!receipt) {
				const binding = await bindOnboardingProjectTarget(
					target,
					getActiveUserId()
				);
				const project = await createProject(
					target,
					buildFirstProjectInput(draft, coordinatorAgentId)
				);
				receipt = { project, binding, folderApplied: false };
				acknowledgedReceipt.current = receipt;
				setAcknowledged(true);
			}
			if (!receipt.folderApplied) {
				if (folder) {
					addProjectFolder(folder);
				}
				receipt.folderApplied = true;
			}
			await onCreated(receipt.project, receipt.binding);
		} catch (cause) {
			setError(
				skipPending.current
					? tl("Setup could not skip this project: {reason}", {
							reason:
								cause instanceof Error ? cause.message : "Retry skipping.",
						})
					: acknowledgedReceipt.current
						? tl(
								"Your project was created, but setup could not continue: {reason}",
								{
									reason:
										cause instanceof Error
											? cause.message
											: "Retry continuation.",
								}
							)
						: errorMessage(cause, tl)
			);
		} finally {
			submissionPending.current = false;
			setSubmitting(false);
		}
	};

	return (
		<div
			className="scroll-fade h-full w-full overflow-y-auto"
			data-testid="first-project-step"
		>
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-7 px-8 py-10"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="flex flex-col items-center gap-4">
						<GlyphPicker
							allowed="entity"
							className="shrink-0"
							disabled={submitting || acknowledged}
							onChange={setIcon}
							previewSize={72}
							title="Choose a project icon"
							value={icon}
						/>
						<PageHeader
							className="w-full max-w-md text-center"
							stagger={false}
							subtitle="Projects keep a goal, its context and the bots working on it in one place. Your agent coordinates it."
							title="Create your first project"
						/>
					</div>
				</StaggerReveal>

				<form
					className="flex w-full max-w-md flex-col gap-4"
					onSubmit={(event) => void handleSubmit(event)}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="first-project-name">Project name</Label>
						<Input
							autoComplete="off"
							disabled={submitting || acknowledged}
							id="first-project-name"
							maxLength={FIRST_PROJECT_NAME_MAX}
							onChange={(event) => setName(event.target.value)}
							value={name}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="first-project-about">
							What is this project about?{" "}
							<span className="text-muted-foreground">(optional)</span>
						</Label>
						<Textarea
							disabled={submitting || acknowledged}
							id="first-project-about"
							maxLength={FIRST_PROJECT_ABOUT_MAX}
							onChange={(event) => setAbout(event.target.value)}
							placeholder="The goal, the constraints, anything every bot should know."
							rows={3}
							value={about}
						/>
					</div>
					{canPickFolder ? (
						<div className="flex items-center justify-between gap-3">
							<p className="min-w-0 truncate text-muted-foreground text-sm">
								{folder ?? "No folder yet (optional)"}
							</p>
							<Button
								disabled={submitting || acknowledged}
								onClick={() => void chooseFolder()}
								size="sm"
								type="button"
								variant="outline"
							>
								{folder ? "Change folder" : "Add a folder"}
							</Button>
						</div>
					) : null}

					<div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
						<RyuOnboardingAvatar size={28} />
						<p className="text-muted-foreground text-sm">
							<span className="font-medium text-foreground">
								{agentName || "Ryu"}
							</span>{" "}
							will coordinate this project.
						</p>
					</div>

					{error ? (
						<p className="text-center text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}

					<div className="mt-2 flex items-center justify-center gap-3">
						<Button
							disabled={submitting}
							onClick={() => {
								skipPending.current = true;
								try {
									onSkip();
									skipPending.current = false;
								} catch (cause) {
									setError(
										cause instanceof Error
											? cause.message
											: "Setup could not skip this project. Retry."
									);
								}
							}}
							type="button"
							variant="ghost"
						>
							Skip for now
						</Button>
						<Button
							disabled={
								(!skipPending.current && Boolean(validation)) || submitting
							}
							size="lg"
							type="submit"
							variant="mono"
						>
							{submitting
								? acknowledged
									? "Continuing…"
									: "Creating…"
								: error
									? "Retry"
									: "Create project"}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
