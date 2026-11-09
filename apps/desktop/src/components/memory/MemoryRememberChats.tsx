// apps/desktop/src/components/memory/MemoryRememberChats.tsx
//
// The "Remember chats" setting on the Dream screen, and the prompt Dream shows
// when Core refuses a review because the setting is off. The prompt only turns
// the setting on when the person presses its button.

import { Message01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Card, CardContent } from "@ryu/ui/components/card.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { RememberChatsState } from "@/src/hooks/useRememberChats.ts";

export function MemoryRememberChatsCard({
	chats,
}: {
	chats: RememberChatsState;
}) {
	return (
		<Card
			appearance="dream-highlight"
			data-testid="memory-remember-chats"
			elevation="flat"
		>
			<CardContent layout="summary-actions" topSpacing="generous">
				<div className="flex items-start gap-3">
					<div className="rounded-full bg-primary/10 p-2 text-primary">
						<HugeiconsIcon className="size-4" icon={Message01Icon} />
					</div>
					<div>
						<Label htmlFor="memory-remember-chats">Remember chats</Label>
						<p className="mt-1 text-muted-foreground text-xs">
							Let Ryu index your conversations so Dream can review them and you
							can search past chats. Message text stays encrypted. Turning this
							off clears the index; your chats stay saved.
						</p>
						{chats.error === "load" ? (
							<p className="mt-1 text-status-destructive text-xs" role="alert">
								Couldn't load the Remember chats setting.
							</p>
						) : null}
						{chats.error === "save" ? (
							<p className="mt-1 text-status-destructive text-xs" role="alert">
								Couldn't update Remember chats. Please try again.
							</p>
						) : null}
					</div>
				</div>
				<Switch
					checked={chats.enabled === true}
					disabled={chats.loading || chats.saving || chats.enabled === null}
					id="memory-remember-chats"
					onCheckedChange={(next) => void chats.setEnabled(next)}
				/>
			</CardContent>
		</Card>
	);
}

export function MemoryRememberChatsPrompt({
	onEnable,
	saving,
}: {
	onEnable: () => void;
	saving: boolean;
}) {
	return (
		<Empty appearance="bordered" data-testid="dream-remember-chats-prompt">
			<EmptyHeader>
				<EmptyTitle>Dream needs Remember chats</EmptyTitle>
				<EmptyDescription>
					Dream learns from your recent conversations, so Remember chats must be
					on before it can run. Turn it on here, then run Dream again.
				</EmptyDescription>
			</EmptyHeader>
			<Button disabled={saving} onClick={onEnable}>
				<HugeiconsIcon className="size-4" icon={Message01Icon} />
				Turn on Remember chats
			</Button>
		</Empty>
	);
}
