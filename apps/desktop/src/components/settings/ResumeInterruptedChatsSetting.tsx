import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	getAutoResumeInterruptedThreads,
	setAutoResumeInterruptedThreads,
} from "@/src/lib/api/auto-resume-preference.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { SettingsItem } from "./shared/settings-items.tsx";

/** Node-level switch for Core's boot auto-resume of interrupted chats. */
export function ResumeInterruptedChatsSetting() {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const queryKey = [
		"auto-resume-interrupted-threads",
		target.url,
		target.token,
	];
	const enabledQuery = useQuery({
		queryKey,
		queryFn: () => getAutoResumeInterruptedThreads(target),
	});
	const save = useMutation({
		mutationFn: (enabled: boolean) =>
			setAutoResumeInterruptedThreads(target, enabled),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey });
		},
		onError: (error: Error) => {
			toast.error("Couldn't update the resume setting", {
				description: error.message,
			});
		},
	});

	return (
		<SettingsItem
			actions={
				<Switch
					checked={enabledQuery.data ?? true}
					disabled={
						enabledQuery.isLoading || enabledQuery.isError || save.isPending
					}
					id="resume-interrupted-chats-toggle"
					onCheckedChange={(checked) => save.mutate(checked)}
				/>
			}
			description="If Ryu stops while an agent is working (a crash, restart, or power loss), it picks those chats back up on its own the next time it starts. Each interrupted turn is retried at most twice, and turns older than 7 days are left for you."
			settingsId="general.chats.resume-interrupted-chats"
			title="Resume interrupted chats"
		/>
	);
}
