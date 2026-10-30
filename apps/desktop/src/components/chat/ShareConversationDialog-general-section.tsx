import {
	Globe02Icon,
	InformationCircleIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
	PrincipalDirectory,
} from "@/src/lib/api/conversation-sharing.ts";
import {
	type GeneralAccess,
	isGeneralAccess,
} from "./ShareConversationDialog-access.ts";

export function ShareConversationGeneralSection({
	access,
	canManage,
	directory,
	generalAccess,
	owner,
	setAccess,
	setError,
	setGeneralAccess,
}: {
	access: ConversationAccess;
	canManage: boolean;
	directory: PrincipalDirectory | null;
	generalAccess: GeneralAccess;
	owner: StoredAccount | null;
	setAccess: (access: ConversationAccess) => void;
	setError: (error: string | null) => void;
	setGeneralAccess: (value: GeneralAccess) => void;
}) {
	return (
		<section aria-labelledby="share-general-heading" className="space-y-3">
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
						<SelectTrigger aria-label="General access" className="w-full">
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
								<SelectItem value="org">Anyone in the organization</SelectItem>
							) : null}
							{directory?.teams.length ? (
								<SelectItem value="team">A team</SelectItem>
							) : null}
							<SelectItem disabled={!(owner && canManage)} value="public">
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
										directory?.teams.find((team) => team.id === value)?.name ??
										"Choose a team"
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
						The public link contains the reviewed, redacted text copy. Tool
						activity, files, and later messages are excluded. Use Update copy to
						publish a newer snapshot.
					</p>
				</div>
			) : null}
		</section>
	);
}
