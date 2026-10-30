import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type A2aServerConfig, saveA2aSettings } from "@/src/lib/api/a2a.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { errorMessage, SectionCard } from "./A2aSettings-shared.tsx";

export function ServerConfigForm({
	config,
	onSaved,
	target,
}: {
	config: A2aServerConfig;
	onSaved: () => Promise<void>;
	target: ApiTarget;
}) {
	const [draft, setDraft] = useState(config);
	const mutation = useMutation({
		mutationFn: () => saveA2aSettings(target, draft),
		onSuccess: async () => {
			toast.success("A2A endpoint settings saved");
			await onSaved();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const cardUrl = draft.publicBaseUrl
		? `${draft.publicBaseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`
		: `${target.url.replace(/\/$/, "")}/.well-known/agent-card.json`;

	return (
		<SectionCard
			description="Expose selected local agents through the Linux Foundation A2A v1 HTTP protocol. Inbound access stays off until you enable it and issue a peer token."
			title="Agent-to-Agent endpoint"
		>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Accept inbound A2A tasks</p>
					<p className="text-muted-foreground text-xs">
						Publishes JSON-RPC and HTTP+JSON interfaces with streaming and push
						updates.
					</p>
				</div>
				<Switch
					aria-label="Accept inbound A2A tasks"
					checked={draft.enabled}
					onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="a2a-display-name">Display name</Label>
					<Input
						id="a2a-display-name"
						onChange={(event) =>
							setDraft({ ...draft, displayName: event.target.value })
						}
						value={draft.displayName}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-public-base">Public base URL</Label>
					<Input
						id="a2a-public-base"
						onChange={(event) =>
							setDraft({
								...draft,
								publicBaseUrl: event.target.value || null,
							})
						}
						placeholder="https://agent.example.com"
						value={draft.publicBaseUrl ?? ""}
					/>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="a2a-description">Description</Label>
				<Input
					id="a2a-description"
					onChange={(event) =>
						setDraft({ ...draft, description: event.target.value })
					}
					value={draft.description}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="a2a-concurrency">Maximum concurrent tasks</Label>
					<Input
						id="a2a-concurrency"
						max={1024}
						min={1}
						onChange={(event) =>
							setDraft({
								...draft,
								maxConcurrentTasks: Number(event.target.value),
							})
						}
						type="number"
						value={draft.maxConcurrentTasks}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="a2a-payload-limit">Maximum payload (MiB)</Label>
					<Input
						id="a2a-payload-limit"
						max={16}
						min={1}
						onChange={(event) =>
							setDraft({
								...draft,
								maxPayloadBytes: Number(event.target.value) * 1024 * 1024,
							})
						}
						type="number"
						value={draft.maxPayloadBytes / (1024 * 1024)}
					/>
				</div>
			</div>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Authenticated extended card</p>
					<p className="text-muted-foreground text-xs">
						Let authorized peers fetch the extended Agent Card.
					</p>
				</div>
				<Switch
					aria-label="Expose authenticated extended Agent Card"
					checked={draft.exposeExtendedCard}
					onCheckedChange={(exposeExtendedCard) =>
						setDraft({ ...draft, exposeExtendedCard })
					}
				/>
			</div>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="font-medium text-sm">Require signed peer cards</p>
					<p className="text-muted-foreground text-xs">
						Only discover peers whose Agent Card signature verifies.
					</p>
				</div>
				<Switch
					aria-label="Require verified Agent Card signatures from peers"
					checked={draft.requireSignedPeerCards ?? false}
					onCheckedChange={(requireSignedPeerCards) =>
						setDraft({ ...draft, requireSignedPeerCards })
					}
				/>
			</div>
			<div className="rounded-md border bg-background/60 px-3 py-2">
				<p className="text-muted-foreground text-xs">Agent Card</p>
				<code className="break-all text-xs">{cardUrl}</code>
			</div>
			<Button
				loading={mutation.isPending}
				onClick={() => mutation.mutate()}
				size="sm"
			>
				Save endpoint
			</Button>
		</SectionCard>
	);
}
