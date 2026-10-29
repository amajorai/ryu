import {
	Cancel01Icon,
	Copy01Icon,
	Globe02Icon,
	InformationCircleIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActiveUserId, listAccounts } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getHistoryPreview,
	type HistoryPreview,
	saveGitHistory,
	syncGitHistory,
} from "@/src/lib/api/conversation-history.ts";
import {
	type ConversationAccess,
	type ConversationAccessRole,
	getConversationAccess,
	getPrincipalDirectory,
	getPublicShare,
	type PrincipalDirectory,
	type PublicShareStatus,
	publishPublicShare,
	revokePublicShare,
	setConversationAccess,
} from "@/src/lib/api/conversation-sharing.ts";

type GeneralAccess = ConversationAccess["visibility"] | "public";

function initials(name: string): string {
	return (
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

function isGeneralAccess(value: string | null): value is GeneralAccess {
	return ["private", "org", "team", "public"].includes(String(value));
}

function isAccessRole(value: string | null): value is ConversationAccessRole {
	return value === "viewer" || value === "participant";
}

export function ShareConversationDialog({
	conversationId,
	onOpenChange,
	open,
	target,
	title,
}: {
	conversationId: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
	title: string;
}) {
	const activeUserId = getActiveUserId();
	const owner = useMemo(
		() =>
			listAccounts().find((account) => account.userId === activeUserId) ?? null,
		[activeUserId]
	);
	const [access, setAccess] = useState<ConversationAccess | null>(null);
	const [directory, setDirectory] = useState<PrincipalDirectory | null>(null);
	const [generalAccess, setGeneralAccess] = useState<GeneralAccess>("private");
	const [publicShare, setPublicShare] = useState<PublicShareStatus | null>(
		null
	);
	const [personToAdd, setPersonToAdd] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [historyPreview, setHistoryPreview] = useState<HistoryPreview | null>(
		null
	);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [gitSaving, setGitSaving] = useState(false);
	const [gitSaved, setGitSaved] = useState<string | null>(null);
	const [customInput, setCustomInput] = useState("");
	const [appliedTerms, setAppliedTerms] = useState<string[]>([]);
	const draftTerms = useMemo(
		() =>
			customInput
				.split(/\r?\n/)
				.map((term) => term.trim())
				.filter(Boolean),
		[customInput]
	);
	const customDirty =
		JSON.stringify(draftTerms) !== JSON.stringify(appliedTerms);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [nextAccess, nextDirectory] = await Promise.all([
				getConversationAccess(target, conversationId),
				getPrincipalDirectory(target).catch(() => ({ members: [], teams: [] })),
			]);
			const nextPublicShare =
				owner && nextAccess.can_manage
					? await getPublicShare(conversationId).catch(() => null)
					: null;
			setAccess(nextAccess);
			setDirectory(nextDirectory);
			setPublicShare(nextPublicShare);
			setGeneralAccess(nextPublicShare ? "public" : nextAccess.visibility);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: "Could not load sharing settings."
			);
		} finally {
			setLoading(false);
		}
	}, [conversationId, owner, target]);

	const loadPrivacyPreview = useCallback(
		async (terms: string[] = []) => {
			setPreviewLoading(true);
			setPreviewError(null);
			setHistoryPreview(null);
			setGitSaved(null);
			try {
				setHistoryPreview(
					await getHistoryPreview(target, conversationId, terms)
				);
			} catch (previewFailure) {
				setPreviewError(
					previewFailure instanceof Error
						? previewFailure.message
						: "Could not prepare the privacy preview."
				);
			} finally {
				setPreviewLoading(false);
			}
		},
		[conversationId, target]
	);

	useEffect(() => {
		if (open) {
			setCustomInput("");
			setAppliedTerms([]);
			void load();
			void loadPrivacyPreview([]);
		}
	}, [load, loadPrivacyPreview, open]);

	const memberById = useMemo(
		() =>
			new Map(directory?.members.map((member) => [member.id, member]) ?? []),
		[directory]
	);
	const canManage = access?.can_manage ?? false;
	const ownerUserId = access?.owner_user_id ?? activeUserId;
	const ownerMember = ownerUserId ? memberById.get(ownerUserId) : undefined;
	const ownerIsCurrentUser = ownerUserId === activeUserId;
	const ownerName =
		ownerMember?.name ||
		(ownerIsCurrentUser ? owner?.name || owner?.email : ownerUserId) ||
		"Local owner";
	const ownerEmail =
		ownerMember?.email ||
		(ownerIsCurrentUser ? owner?.email : ownerUserId) ||
		"";
	const availableMembers = useMemo(() => {
		const selected = new Set(
			access?.collaborators.map((collaborator) => collaborator.user_id) ?? []
		);
		return (
			directory?.members.filter(
				(member) => member.id !== ownerUserId && !selected.has(member.id)
			) ?? []
		);
	}, [access?.collaborators, directory?.members, ownerUserId]);

	const addPerson = (userId: string | null) => {
		if (!(userId && access)) {
			return;
		}
		setAccess({
			...access,
			collaborators: [
				...access.collaborators,
				{ role: "viewer", user_id: userId },
			],
		});
		setPersonToAdd(null);
		setError(null);
	};

	const updateRole = (userId: string, role: ConversationAccessRole) => {
		setError(null);
		setAccess((current) =>
			current
				? {
						...current,
						collaborators: current.collaborators.map((collaborator) =>
							collaborator.user_id === userId
								? { ...collaborator, role }
								: collaborator
						),
					}
				: current
		);
	};

	const removePerson = (userId: string) => {
		setError(null);
		setAccess((current) =>
			current
				? {
						...current,
						collaborators: current.collaborators.filter(
							(collaborator) => collaborator.user_id !== userId
						),
					}
				: current
		);
	};

	const publish = async (): Promise<PublicShareStatus> => {
		if (!historyPreview || customDirty) {
			throw new Error("Review the redacted copy before publishing.");
		}
		const messages = historyPreview.transcript.messages
			.filter(
				(message) => message.role === "user" || message.role === "assistant"
			)
			.slice(-500)
			.map((message) => ({
				content: message.content,
				created_at: Date.parse(message.createdAt),
				id: message.id,
				// SAFETY: The filter immediately above admits only user and assistant roles; slice preserves each admitted message.
				role: message.role as "assistant" | "user",
			}));
		const safeTitle = Array.from(historyPreview.transcript.title)
			.map((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint < 32 || codePoint === 127 ? " " : character;
			})
			.join("")
			.slice(0, 200);
		const nextShare = await publishPublicShare(
			conversationId,
			safeTitle,
			messages
		);
		setPublicShare(nextShare);
		return nextShare;
	};

	const saveToGit = async () => {
		if (!historyPreview?.repoAvailable || customDirty) {
			return;
		}
		setGitSaving(true);
		setError(null);
		try {
			const result = await saveGitHistory(
				target,
				conversationId,
				historyPreview,
				appliedTerms
			);
			setGitSaved(result.checkpoint.checkpointId);
			toast.success(
				result.checkpoint.alreadySaved
					? "Checkpoint is already in Git"
					: "Conversation saved in Git"
			);
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: "Could not save the Git checkpoint."
			);
		} finally {
			setGitSaving(false);
		}
	};

	const pushHistory = async () => {
		if (!historyPreview?.repoRoot || customDirty) {
			return;
		}
		setGitSaving(true);
		setError(null);
		try {
			await syncGitHistory(target, historyPreview.repoRoot, "push");
			toast.success("Conversation history pushed to origin");
		} catch (pushError) {
			setError(
				pushError instanceof Error
					? pushError.message
					: "Could not push Git history."
			);
		} finally {
			setGitSaving(false);
		}
	};

	const copyLink = async () => {
		setSaving(true);
		setError(null);
		try {
			const share = publicShare ?? (await publish());
			await navigator.clipboard.writeText(share.url);
			toast.success("Share link copied");
		} catch (copyError) {
			setError(
				copyError instanceof Error
					? copyError.message
					: "Could not copy the link."
			);
		} finally {
			setSaving(false);
		}
	};

	const refreshPublicCopy = async () => {
		setSaving(true);
		setError(null);
		try {
			await publish();
			toast.success("Shared copy updated");
		} catch (publishError) {
			setError(
				publishError instanceof Error
					? publishError.message
					: "Could not update the shared copy."
			);
		} finally {
			setSaving(false);
		}
	};

	const save = async () => {
		if (!access) {
			return;
		}
		if (!canManage) {
			onOpenChange(false);
			return;
		}
		if (generalAccess === "team" && !access.team_id) {
			setError("Choose a team before saving.");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const coreAccess: Pick<
				ConversationAccess,
				"collaborators" | "team_id" | "visibility"
			> = {
				collaborators: access.collaborators,
				team_id: generalAccess === "team" ? access.team_id : null,
				visibility: generalAccess === "public" ? "private" : generalAccess,
			};
			if (generalAccess === "public") {
				await setConversationAccess(target, conversationId, coreAccess);
				await publish();
			} else {
				if (owner) {
					// Only the caller's own public link is being turned off here.
					await revokePublicShare(conversationId, owner.userId);
				}
				await setConversationAccess(target, conversationId, coreAccess);
				setPublicShare(null);
			}
			toast.success("Sharing settings saved");
			onOpenChange(false);
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: "Could not save sharing settings."
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				appearance="conversation-share"
				data-testid="share-conversation-dialog"
			>
				<DialogHeader purpose="records-panel">
					<DialogTitle typography="conversation-share">
						Share “{title}”
					</DialogTitle>
					<DialogDescription>
						Invite people to the live chat or publish a private, frozen copy.
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 overflow-y-auto px-6 py-5">
					{loading ? (
						<SkeletonRows
							label="Loading sharing settings…"
							spacing="comfortable"
						/>
					) : error && !access ? (
						<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
							<p className="font-medium">Sharing is unavailable</p>
							<p className="mt-1 text-muted-foreground">{error}</p>
							<Button
								className="mt-4"
								onClick={() => void load()}
								size="sm"
								variant="outline"
							>
								Try again
							</Button>
						</div>
					) : access ? (
						<div className="space-y-6">
							<section
								aria-labelledby="share-people-heading"
								className="space-y-3"
							>
								<div>
									<h3 className="font-medium text-sm" id="share-people-heading">
										People with access
									</h3>
									<p className="mt-0.5 text-muted-foreground text-xs">
										Viewers can read. Participants can send new messages.
									</p>
								</div>

								{availableMembers.length > 0 ? (
									<Select
										disabled={!canManage}
										onValueChange={(value) =>
											addPerson(isNativeText(value) ? value : null)
										}
										value={personToAdd}
									>
										<SelectTrigger aria-label="Add a person" className="w-full">
											<SelectValue placeholder="Add people" />
										</SelectTrigger>
										<SelectContent>
											{availableMembers.map((member) => (
												<SelectItem key={member.id} value={member.id}>
													<span className="flex min-w-0 flex-col">
														<span className="truncate" title={member.name}>
															{member.name}
														</span>
														{member.email ? (
															<span
																className="truncate text-muted-foreground text-xs"
																title={member.email}
															>
																{member.email}
															</span>
														) : null}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : null}

								<div className="divide-y rounded-xl border">
									{ownerUserId || owner ? (
										<div className="flex items-center gap-3 px-3 py-3">
											<Avatar className="size-9">
												{ownerIsCurrentUser && owner?.image ? (
													<AvatarImage alt="" src={owner.image} />
												) : null}
												<AvatarFallback>{initials(ownerName)}</AvatarFallback>
											</Avatar>
											<div className="min-w-0 flex-1">
												<p className="truncate font-medium text-sm">
													{ownerName}
													{ownerIsCurrentUser ? " (you)" : ""}
												</p>
												<p
													className="truncate text-muted-foreground text-xs"
													title={ownerEmail}
												>
													{ownerEmail}
												</p>
											</div>
											<span className="text-muted-foreground text-xs">
												Owner
											</span>
										</div>
									) : null}

									{access.collaborators.map((collaborator) => {
										const member = memberById.get(collaborator.user_id);
										const name = member?.name || collaborator.user_id;
										return (
											<div
												className="flex items-center gap-3 px-3 py-3"
												key={collaborator.user_id}
											>
												<Avatar className="size-9">
													<AvatarFallback>{initials(name)}</AvatarFallback>
												</Avatar>
												<div className="min-w-0 flex-1">
													<p
														className="truncate font-medium text-sm"
														title={name}
													>
														{name}
													</p>
													<p
														className="truncate text-muted-foreground text-xs"
														title={member?.email || collaborator.user_id}
													>
														{member?.email || collaborator.user_id}
													</p>
												</div>
												<Select
													disabled={!canManage}
													onValueChange={(value) => {
														if (isAccessRole(value)) {
															updateRole(collaborator.user_id, value);
														}
													}}
													value={collaborator.role}
												>
													<SelectTrigger
														aria-label={`Role for ${name}`}
														className="w-32"
													>
														<SelectValue>
															{(value) =>
																value === "participant"
																	? "Participant"
																	: "Viewer"
															}
														</SelectValue>
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="viewer">Viewer</SelectItem>
														<SelectItem value="participant">
															Participant
														</SelectItem>
													</SelectContent>
												</Select>
												<Button
													aria-label={`Remove ${name}`}
													disabled={!canManage}
													onClick={() => removePerson(collaborator.user_id)}
													size="icon-sm"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={Cancel01Icon}
													/>
												</Button>
											</div>
										);
									})}
								</div>
							</section>

							<section
								aria-labelledby="share-general-heading"
								className="space-y-3"
							>
								<h3 className="font-medium text-sm" id="share-general-heading">
									General access
								</h3>
								<div className="flex items-start gap-3 rounded-xl border p-3">
									<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
										<HugeiconsIcon
											className="size-4"
											icon={generalAccess === "public" ? Globe02Icon : LockIcon}
										/>
									</div>
									<div className="min-w-0 flex-1 space-y-2">
										<Select
											disabled={!canManage}
											onValueChange={(value) => {
												if (isGeneralAccess(value)) {
													setGeneralAccess(value);
													setError(null);
												}
											}}
											value={generalAccess}
										>
											<SelectTrigger
												aria-label="General access"
												className="w-full"
											>
												<SelectValue>
													{(value) => {
														switch (value) {
															case "org":
																return "Anyone in the organization";
															case "team":
																return "A team";
															case "public":
																return "Anyone with the link";
															default:
																return "Restricted";
														}
													}}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="private">Restricted</SelectItem>
												{directory?.org_id ? (
													<SelectItem value="org">
														Anyone in the organization
													</SelectItem>
												) : null}
												{directory?.teams.length ? (
													<SelectItem value="team">A team</SelectItem>
												) : null}
												<SelectItem
													disabled={!(owner && canManage)}
													value="public"
												>
													Anyone with the link
												</SelectItem>
											</SelectContent>
										</Select>

										{generalAccess === "team" ? (
											<Select
												disabled={!canManage}
												onValueChange={(value) => {
													setAccess({
														...access,
														team_id: isNativeText(value) ? value : null,
													});
													setError(null);
												}}
												value={access.team_id}
											>
												<SelectTrigger aria-label="Team" className="w-full">
													<SelectValue placeholder="Choose a team">
														{(value) =>
															directory?.teams.find((team) => team.id === value)
																?.name ?? "Choose a team"
														}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													{directory?.teams.map((team) => (
														<SelectItem key={team.id} value={team.id}>
															{team.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										) : null}
										<p className="text-muted-foreground text-xs">
											{canManage
												? generalAccess === "private"
													? "Only invited people can open the live chat."
													: null
												: "Only the owner or an organization admin can change access."}
											{generalAccess === "org"
												? "Everyone in your organization can participate."
												: null}
											{generalAccess === "team"
												? "Members of the selected team can participate."
												: null}
											{generalAccess === "public"
												? "Anyone with the URL can view a frozen copy without signing in."
												: null}
										</p>
									</div>
								</div>

								{generalAccess === "public" ? (
									<div className="flex gap-2 rounded-lg bg-primary/8 p-3 text-xs">
										<HugeiconsIcon
											className="mt-0.5 size-4 shrink-0 text-primary"
											icon={InformationCircleIcon}
										/>
										<p>
											The public link contains the reviewed, redacted text copy.
											Tool activity, files, and later messages are excluded. Use
											Update copy to publish a newer snapshot.
										</p>
									</div>
								) : null}
							</section>

							<section
								aria-labelledby="share-history-heading"
								className="space-y-3 border-t pt-5"
							>
								<div>
									<h3
										className="font-medium text-sm"
										id="share-history-heading"
									>
										Portable history
									</h3>
									<p className="mt-0.5 text-muted-foreground text-xs">
										Review the text that can be shared or saved beside this
										project&apos;s commits.
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
											<p
												className="font-medium"
												data-testid="history-preview-summary"
											>
												{historyPreview.transcript.messages.length} messages ·{" "}
												{historyPreview.redactions.pii} PII ·{" "}
												{historyPreview.redactions.secrets} secrets ·{" "}
												{historyPreview.redactions.custom ?? 0} custom redacted
											</p>
											{historyPreview.transcript.omittedStructuredParts > 0 ? (
												<p className="mt-1 text-muted-foreground">
													{historyPreview.transcript.omittedStructuredParts}{" "}
													structured tool and file parts omitted.
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
															<p className="font-medium capitalize">
																{message.role}
															</p>
															<p className="whitespace-pre-wrap break-words text-muted-foreground">
																{message.content}
															</p>
														</div>
													))}
												</div>
											</details>
										</div>
										<p className="text-muted-foreground text-xs">
											Detection can miss names and unfamiliar secrets. Review
											the copy before sharing or pushing Git history.
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

							{error ? (
								<p
									aria-live="polite"
									className="text-sm text-status-destructive"
									role="alert"
								>
									{error}
								</p>
							) : null}
						</div>
					) : null}
				</div>

				<DialogFooter
					className="flex-row items-center justify-between sm:justify-between"
					purpose="panel-actions"
				>
					<div className="flex items-center gap-2">
						{generalAccess === "public" && access ? (
							<>
								<Button
									disabled={saving || !canManage || customDirty}
									onClick={() => void copyLink()}
									variant="outline"
								>
									<HugeiconsIcon className="mr-2 size-4" icon={Copy01Icon} />{" "}
									Copy link
								</Button>
								{publicShare ? (
									<Button
										disabled={saving || !canManage || customDirty}
										onClick={() => void refreshPublicCopy()}
										variant="ghost"
									>
										Update copy
									</Button>
								) : null}
							</>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						<Button
							disabled={saving}
							onClick={() => onOpenChange(false)}
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={
								loading ||
								saving ||
								!access ||
								(generalAccess === "public" && (!historyPreview || customDirty))
							}
							onClick={() => void save()}
						>
							{saving ? (
								<>
									<Spinner className="mr-2" /> Saving
								</>
							) : (
								"Done"
							)}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
