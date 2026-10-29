// apps/desktop/src/components/layout/LinkedPullRequestsDialog.tsx
//
// Manage the GitHub pull requests linked to one chat. A chat can carry several
// (a stacked change, a cross-repo fix); the pull request its branch owns is
// shown too but is implicit and cannot be unlinked here.

import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
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
import { useEffect, useState } from "react";
import { GitPullRequestStatusIcon } from "@/src/components/panels/GitPullRequestSummary.tsx";
import { useLinkedPullRequestStatus } from "@/src/hooks/useGitPullRequest.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { parsePullRequestUrl } from "@/src/lib/api/pull-requests.ts";

function LinkedPullRequestRow({
	busy,
	onUnlink,
	target,
	url,
}: {
	busy: boolean;
	onUnlink: () => void;
	target: ApiTarget;
	url: string;
}) {
	const { data } = useLinkedPullRequestStatus(target, url, true);
	const reference = parsePullRequestUrl(url);
	const fallback = reference
		? `${reference.owner}/${reference.repo}#${reference.number}`
		: url;
	return (
		<li className="flex items-center gap-2 py-1.5">
			{data ? <GitPullRequestStatusIcon pullRequest={data} /> : null}
			<a
				className="min-w-0 flex-1 truncate text-sm hover:underline"
				href={safeHttpUrl(url) ?? undefined}
				rel="noopener noreferrer"
				target="_blank"
				title={url}
			>
				{data ? `#${data.number} ${data.title}` : fallback}
			</a>
			<Button
				disabled={busy}
				onClick={onUnlink}
				size="sm"
				type="button"
				variant="ghost"
			>
				Unlink
			</Button>
		</li>
	);
}

export function LinkedPullRequestsDialog({
	linkedPullRequests,
	onOpenChange,
	onSetLinked,
	open,
	target,
	title,
}: {
	linkedPullRequests: readonly string[];
	onOpenChange: (open: boolean) => void;
	onSetLinked: (url: string, linked: boolean) => Promise<void>;
	open: boolean;
	target: ApiTarget;
	title: string;
}) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setDraft("");
			setError(null);
		}
	}, [open]);

	const run = async (url: string, linked: boolean) => {
		setBusy(true);
		setError(null);
		try {
			await onSetLinked(url, linked);
			if (linked) {
				setDraft("");
			}
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not update the chat"
			);
		} finally {
			setBusy(false);
		}
	};

	const submit = () => {
		const reference = parsePullRequestUrl(draft);
		if (!reference) {
			setError("Paste a GitHub pull request link, like github.com/o/r/pull/1");
			return;
		}
		if (linkedPullRequests.includes(reference.url)) {
			setError("That pull request is already linked");
			return;
		}
		run(reference.url, true).catch(() => undefined);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Linked pull requests</DialogTitle>
					<DialogDescription>{title}</DialogDescription>
				</DialogHeader>
				{linkedPullRequests.length > 0 ? (
					<ul
						aria-label="Linked pull requests"
						className="divide-y divide-border/60"
					>
						{linkedPullRequests.map((url) => (
							<LinkedPullRequestRow
								busy={busy}
								key={url}
								onUnlink={() => {
									run(url, false).catch(() => undefined);
								}}
								target={target}
								url={url}
							/>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						No pull requests linked yet. The pull request for this chat’s branch
						is tracked automatically.
					</p>
				)}
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<Input
						aria-describedby={error ? "linked-pull-request-error" : undefined}
						aria-invalid={error ? true : undefined}
						aria-label="Pull request link"
						onChange={(event) => setDraft(event.target.value)}
						placeholder="https://github.com/owner/repo/pull/123"
						value={draft}
					/>
					{error ? (
						<p
							className="text-status-destructive text-xs"
							id="linked-pull-request-error"
							role="alert"
						>
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							onClick={() => onOpenChange(false)}
							type="button"
							variant="ghost"
						>
							Done
						</Button>
						<Button disabled={busy || !draft.trim()} type="submit">
							Link pull request
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
