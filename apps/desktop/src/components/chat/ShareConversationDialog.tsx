import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActiveUserId, listAccounts } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
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
import type { GeneralAccess } from "./ShareConversationDialog-access.ts";
import { ShareConversationGeneralSection } from "./ShareConversationDialog-general-section.tsx";
import { ShareConversationHistorySection } from "./ShareConversationDialog-history-section.tsx";
import { useShareConversationHistory } from "./ShareConversationDialog-history-state.ts";
import { ShareConversationPeopleSection } from "./ShareConversationDialog-people-section.tsx";

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
	const tl = useLiteralMessages();
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
	const history = useShareConversationHistory({
		conversationId,
		setError,
		target,
	});
	const {
		customDirty,
		historyPreview,
		loadPrivacyPreview,
		setAppliedTerms,
		setCustomInput,
	} = history;

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
						{tl("Share “{title}”", { title })}
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
							<ShareConversationPeopleSection
								access={access}
								addPerson={addPerson}
								availableMembers={availableMembers}
								canManage={canManage}
								memberById={memberById}
								owner={owner}
								ownerEmail={ownerEmail}
								ownerIsCurrentUser={ownerIsCurrentUser}
								ownerName={ownerName}
								ownerUserId={ownerUserId}
								personToAdd={personToAdd}
								removePerson={removePerson}
								updateRole={updateRole}
							/>

							<ShareConversationGeneralSection
								access={access}
								canManage={canManage}
								directory={directory}
								generalAccess={generalAccess}
								owner={owner}
								setAccess={setAccess}
								setError={setError}
								setGeneralAccess={setGeneralAccess}
							/>

							<ShareConversationHistorySection
								canManage={canManage}
								history={history}
							/>

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
