import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { ShareConversationHistoryState } from "./ShareConversationDialog-history-state.ts";

export function ShareConversationHistorySection({
	canManage,
	history,
}: {
	canManage: boolean;
	history: ShareConversationHistoryState;
}) {
	const tl = useLiteralMessages();
	const {
		appliedTerms,
		customDirty,
		customInput,
		draftTerms,
		gitSaved,
		gitSaving,
		historyPreview,
		loadPrivacyPreview,
		previewError,
		previewLoading,
		pushHistory,
		saveToGit,
		setAppliedTerms,
		setCustomInput,
		setGitSaved,
	} = history;
	return (
		<section
			aria-labelledby="share-history-heading"
			className="space-y-3 border-t pt-5"
		>
			<div>
				<h3 className="font-medium text-sm" id="share-history-heading">
					Portable history
				</h3>
				<p className="mt-0.5 text-muted-foreground text-xs">
					Review the text that can be shared or saved beside this project&apos;s
					commits.
				</p>
			</div>
			<div className="space-y-2">
				<label
					className="font-medium text-xs"
					htmlFor="history-extra-redactions"
				>
					More terms to hide
				</label>
				<Textarea
					id="history-extra-redactions"
					onChange={(event) => {
						setCustomInput(event.target.value);
						setGitSaved(null);
					}}
					placeholder="One name, code name, or secret per line"
					rows={2}
					value={customInput}
				/>
				<div className="flex items-center gap-2">
					<Button
						disabled={!customDirty || previewLoading}
						onClick={() => {
							setAppliedTerms(draftTerms);
							void loadPrivacyPreview(draftTerms);
						}}
						size="sm"
						variant="outline"
					>
						Apply to preview
					</Button>
					{customDirty ? (
						<span className="text-muted-foreground text-xs">
							Apply changes before sharing or saving.
						</span>
					) : null}
				</div>
			</div>
			{previewLoading ? (
				<p className="flex items-center gap-2 text-muted-foreground text-xs">
					<Spinner className="size-3" /> Preparing redacted preview…
				</p>
			) : previewError ? (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
					<p role="alert">{previewError}</p>
					<Button
						className="mt-2"
						onClick={() => void loadPrivacyPreview(appliedTerms)}
						size="sm"
						variant="outline"
					>
						Retry preview
					</Button>
				</div>
			) : historyPreview ? (
				<>
					<div className="rounded-xl border bg-muted/30 p-3 text-xs">
						<p className="font-medium" data-testid="history-preview-summary">
							{tl(
								"{length} messages · {pii} PII · {secrets} secrets · {custom} custom redacted",
								{
									custom: String(historyPreview.redactions.custom ?? 0),
									length: String(historyPreview.transcript.messages.length),
									pii: String(historyPreview.redactions.pii),
									secrets: String(historyPreview.redactions.secrets),
								}
							)}
						</p>
						{historyPreview.transcript.omittedStructuredParts > 0 ? (
							<p className="mt-1 text-muted-foreground">
								{tl(
									"{omittedStructuredParts} structured tool and file parts omitted.",
									{
										omittedStructuredParts: String(
											historyPreview.transcript.omittedStructuredParts
										),
									}
								)}
							</p>
						) : null}
						<details className="mt-3">
							<summary className="cursor-pointer font-medium">
								Review redacted transcript
							</summary>
							<div
								className="mt-2 max-h-56 space-y-2 overflow-auto rounded-lg border bg-background p-3"
								data-testid="history-redacted-transcript"
							>
								{historyPreview.transcript.messages.map((message) => (
									<div key={message.id}>
										<p className="font-medium capitalize">{message.role}</p>
										<p className="whitespace-pre-wrap break-words text-muted-foreground">
											{message.content}
										</p>
									</div>
								))}
							</div>
						</details>
					</div>
					<p className="text-muted-foreground text-xs">
						Detection can miss names and unfamiliar secrets. Review the copy
						before sharing or pushing Git history.
					</p>
					{historyPreview.repoAvailable ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								disabled={!canManage || gitSaving || customDirty}
								onClick={() => void saveToGit()}
								size="sm"
								variant="outline"
							>
								Save in Git
							</Button>
							{gitSaved ? (
								<>
									<span className="font-mono text-muted-foreground text-xs">
										{gitSaved.slice(0, 12)}
									</span>
									<Button
										disabled={!canManage || gitSaving || customDirty}
										onClick={() => void pushHistory()}
										size="sm"
										variant="outline"
									>
										Push history to origin
									</Button>
								</>
							) : null}
						</div>
					) : (
						<p className="text-muted-foreground text-xs">
							{historyPreview.repoError}
						</p>
					)}
				</>
			) : null}
		</section>
	);
}
