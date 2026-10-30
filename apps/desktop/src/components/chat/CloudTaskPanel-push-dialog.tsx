// apps/desktop/src/components/chat/CloudTaskPanel-push-dialog.tsx
//
// The cloud task panel's push dialog: commit the box's changes, push a branch,
// and optionally open a GitHub pull request through Core.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useEffect, useId, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudTaskFinish,
	finishCloudTask,
} from "@/src/lib/api/cloud-tasks.ts";
import {
	characterCount,
	codePointLength,
	DEFAULT_COMMIT_MESSAGE,
	failureMessage,
	MAX_PULL_REQUEST_BODY_CHARS,
	MAX_PULL_REQUEST_TITLE_CHARS,
	pullRequestFailure,
} from "./CloudTaskPanel-labels.ts";

export function PushDialog({
	baseBranch,
	conversationId,
	onFinished,
	onOpenChange,
	open,
	target,
}: {
	/** The branch the task started from; pull requests target it. */
	baseBranch: string | null;
	conversationId: string;
	onFinished: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const branchId = useId();
	const messageId = useId();
	const teardownId = useId();
	const pullRequestId = useId();
	const pullRequestTitleId = useId();
	const draftId = useId();
	const pullRequestBodyId = useId();
	const pullRequestBodyHintId = useId();
	const [branch, setBranch] = useState(`ryu/${conversationId.slice(0, 8)}`);
	const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
	const [destroy, setDestroy] = useState(true);
	const [openPullRequest, setOpenPullRequest] = useState(false);
	const [pullRequestTitle, setPullRequestTitle] = useState("");
	const [pullRequestBody, setPullRequestBody] = useState("");
	const [draft, setDraft] = useState(false);
	const pullRequestBodyLength = codePointLength(pullRequestBody);
	const pullRequestBodyTooLong =
		pullRequestBodyLength > MAX_PULL_REQUEST_BODY_CHARS;
	const canOpenPullRequest = baseBranch !== null;
	const wantsPullRequest = canOpenPullRequest && openPullRequest;
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<CloudTaskFinish | null>(null);

	useEffect(() => {
		if (open) {
			setResult(null);
		}
	}, [open]);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (wantsPullRequest && pullRequestBodyTooLong) {
			return;
		}
		setPending(true);
		try {
			const title = pullRequestTitle.trim();
			// A blank body is omitted so Core writes its default description; any
			// other text is sent as typed, keeping its Markdown formatting.
			const prBody = pullRequestBody.trim() ? pullRequestBody : null;
			const finish = await finishCloudTask(target, conversationId, {
				push: true,
				branch: branch.trim(),
				commitMessage: commitMessage.trim() || DEFAULT_COMMIT_MESSAGE,
				teardown: destroy ? "destroy" : "keep",
				...(wantsPullRequest
					? {
							openPullRequest: true,
							draft,
							...(title ? { pullRequestTitle: title } : {}),
							...(prBody === null ? {} : { pullRequestBody: prBody }),
						}
					: {}),
			});
			setResult(finish);
			if (finish.pullRequest) {
				toast.success(
					tl("Opened pull request #{number}", {
						number: String(finish.pullRequest.number),
					})
				);
			} else if (finish.pushed && finish.pullRequestError) {
				toast.error(pullRequestFailure(finish.pullRequestError));
			} else if (finish.pushed) {
				toast.success(`Pushed ${finish.branch ?? "branch"}`);
			} else {
				toast.error(
					tl("Push failed ({error}). The box was kept.", {
						error: finish.pushError ?? "unknown",
					})
				);
			}
			onFinished();
		} catch (failure) {
			toast.error(failureMessage(failure, "Could not push the branch.", tl));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Push branch</DialogTitle>
					<DialogDescription>
						Commit the box's changes and push them to a new branch on GitHub.
					</DialogDescription>
				</DialogHeader>
				{result?.pushed ? (
					<div className="flex flex-col gap-2 text-sm" role="status">
						<p>
							{tl(
								"Pushed {branch} · {files} files, +{insertions} −{deletions}",
								{
									branch: result.branch ?? "",
									files: String(result.files),
									insertions: String(result.insertions),
									deletions: String(result.deletions),
								}
							)}
						</p>
						{result.pullRequest ? (
							<a
								className="text-primary underline-offset-4 hover:underline"
								href={result.pullRequest.url}
								rel="noopener noreferrer"
								target="_blank"
							>
								{tl("Open pull request #{number} on GitHub", {
									number: String(result.pullRequest.number),
								})}
							</a>
						) : null}
						{result.pullRequestError ? (
							<p className="text-status-destructive">
								{pullRequestFailure(result.pullRequestError)}
							</p>
						) : null}
						{result.compareUrl && !result.pullRequest ? (
							<a
								className="text-primary underline-offset-4 hover:underline"
								href={result.compareUrl}
								rel="noopener noreferrer"
								target="_blank"
							>
								Open the compare view on GitHub
							</a>
						) : null}
					</div>
				) : (
					<form className="flex flex-col gap-3" onSubmit={handleSubmit}>
						{result && !result.pushed ? (
							<p className="text-sm text-status-destructive" role="alert">
								{tl("Push failed ({error}). The box was kept.", {
									error: result.pushError ?? "unknown",
								})}
							</p>
						) : null}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={branchId}>Branch</Label>
							<Input
								id={branchId}
								onChange={(event) => setBranch(event.target.value)}
								required
								value={branch}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={messageId}>Commit message</Label>
							<Input
								id={messageId}
								onChange={(event) => setCommitMessage(event.target.value)}
								value={commitMessage}
							/>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={destroy}
								id={teardownId}
								onCheckedChange={(checked) => setDestroy(checked === true)}
							/>
							<Label htmlFor={teardownId}>Remove the box after pushing</Label>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={wantsPullRequest}
								disabled={!canOpenPullRequest}
								id={pullRequestId}
								onCheckedChange={(checked) =>
									setOpenPullRequest(checked === true)
								}
							/>
							<Label htmlFor={pullRequestId}>
								{canOpenPullRequest
									? tl("Open pull request into {baseBranch}", { baseBranch })
									: "Open pull request (needs a starting branch)"}
							</Label>
						</div>
						{wantsPullRequest ? (
							<>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={pullRequestTitleId}>Pull request title</Label>
									<Input
										id={pullRequestTitleId}
										maxLength={MAX_PULL_REQUEST_TITLE_CHARS}
										onChange={(event) =>
											setPullRequestTitle(event.target.value)
										}
										placeholder={commitMessage.trim() || DEFAULT_COMMIT_MESSAGE}
										value={pullRequestTitle}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={pullRequestBodyId}>
										Pull request description (optional)
									</Label>
									<Textarea
										aria-describedby={pullRequestBodyHintId}
										aria-invalid={pullRequestBodyTooLong || undefined}
										className="max-h-48"
										id={pullRequestBodyId}
										onChange={(event) => setPullRequestBody(event.target.value)}
										placeholder="Describe the change. Markdown is supported."
										rows={4}
										value={pullRequestBody}
									/>
									<p
										className={
											pullRequestBodyTooLong
												? "text-status-destructive text-xs"
												: "text-muted-foreground text-xs"
										}
										id={pullRequestBodyHintId}
										role={pullRequestBodyTooLong ? "alert" : undefined}
									>
										{pullRequestBodyTooLong
											? tl(
													"Too long: {length} of {max} characters. Shorten the description to push.",
													{
														length: characterCount.format(
															pullRequestBodyLength
														),
														max: characterCount.format(
															MAX_PULL_REQUEST_BODY_CHARS
														),
													}
												)
											: `${characterCount.format(pullRequestBodyLength)} / ${characterCount.format(MAX_PULL_REQUEST_BODY_CHARS)} characters`}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<Checkbox
										checked={draft}
										id={draftId}
										onCheckedChange={(checked) => setDraft(checked === true)}
									/>
									<Label htmlFor={draftId}>Open as draft</Label>
								</div>
							</>
						) : null}
						<DialogFooter>
							<Button
								disabled={
									pending ||
									!branch.trim() ||
									(wantsPullRequest && pullRequestBodyTooLong)
								}
								size="sm"
								type="submit"
							>
								{pending ? "Pushing…" : "Push branch"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
