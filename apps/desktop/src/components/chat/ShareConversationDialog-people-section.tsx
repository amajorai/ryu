import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { StoredAccount } from "@/lib/auth-client.ts";
import type {
	ConversationAccess,
	ConversationAccessRole,
	PrincipalDirectory,
} from "@/src/lib/api/conversation-sharing.ts";
import { initials, isAccessRole } from "./ShareConversationDialog-access.ts";

type DirectoryMember = PrincipalDirectory["members"][number];

export function ShareConversationPeopleSection({
	access,
	addPerson,
	availableMembers,
	canManage,
	memberById,
	owner,
	ownerEmail,
	ownerIsCurrentUser,
	ownerName,
	ownerUserId,
	personToAdd,
	removePerson,
	updateRole,
}: {
	access: ConversationAccess;
	addPerson: (userId: string | null) => void;
	availableMembers: DirectoryMember[];
	canManage: boolean;
	memberById: Map<string, DirectoryMember>;
	owner: StoredAccount | null;
	ownerEmail: string;
	ownerIsCurrentUser: boolean;
	ownerName: string;
	ownerUserId: string | null | undefined;
	personToAdd: string | null;
	removePerson: (userId: string) => void;
	updateRole: (userId: string, role: ConversationAccessRole) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<section aria-labelledby="share-people-heading" className="space-y-3">
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
						<span className="text-muted-foreground text-xs">Owner</span>
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
								<p className="truncate font-medium text-sm" title={name}>
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
									aria-label={tl("Role for {name}", { name })}
									className="w-32"
								>
									<SelectValue>
										{(value) =>
											value === "participant" ? "Participant" : "Viewer"
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="viewer">Viewer</SelectItem>
									<SelectItem value="participant">Participant</SelectItem>
								</SelectContent>
							</Select>
							<Button
								aria-label={tl("Remove {name}", { name })}
								disabled={!canManage}
								onClick={() => removePerson(collaborator.user_id)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							</Button>
						</div>
					);
				})}
			</div>
		</section>
	);
}
