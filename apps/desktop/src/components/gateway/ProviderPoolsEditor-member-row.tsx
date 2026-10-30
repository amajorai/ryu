import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { Dispatch, SetStateAction } from "react";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import type { DraftMember, PoolMember } from "./ProviderPoolsEditor-options.ts";

export function ProviderPoolMemberRow({
	member,
	index,
	providers,
	providerLabel,
	controlsDisabled,
	updateMember,
	setMembers,
}: {
	member: DraftMember;
	index: number;
	providers: string[];
	providerLabel: (id: string) => string;
	controlsDisabled: boolean;
	updateMember: (id: string, patch: Partial<PoolMember>) => void;
	setMembers: Dispatch<SetStateAction<DraftMember[]>>;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="grid items-end gap-2 pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_7rem_5rem_5rem_auto_auto]">
			<div className="flex flex-col gap-1">
				<Label htmlFor={`pool-provider-${member.id}`}>
					{tl("Provider {number}", { number: index + 1 })}
				</Label>
				<div className="flex items-center gap-1.5">
					<ProviderBrandLogo providerKey={member.provider} size={16} />
					<Select
						disabled={controlsDisabled}
						items={providers.map((provider) => ({
							value: provider,
							label: providerLabel(provider),
						}))}
						onValueChange={(value) =>
							value && updateMember(member.id, { provider: value })
						}
						value={member.provider}
					>
						<SelectTrigger id={`pool-provider-${member.id}`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{providers.map((provider) => (
								<SelectItem key={provider} value={provider}>
									<span className="flex items-center gap-2">
										<ProviderBrandLogo providerKey={provider} size={14} />
										{providerLabel(provider)}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={`pool-model-${member.id}`}>Upstream model</Label>
				<Input
					disabled={controlsDisabled}
					id={`pool-model-${member.id}`}
					onChange={(event) =>
						updateMember(member.id, { model: event.target.value })
					}
					placeholder="Exact model ID"
					value={member.model}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`pool-context-${member.id}`}>Context tokens</Label>
				<Input
					aria-describedby="pool-context-help"
					disabled={controlsDisabled}
					id={`pool-context-${member.id}`}
					max={2_000_000}
					min={1}
					onChange={(event) =>
						updateMember(member.id, {
							context_tokens:
								event.target.value.trim() === ""
									? undefined
									: Number(event.target.value),
						})
					}
					placeholder="Unknown"
					type="number"
					value={member.context_tokens ?? ""}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={`pool-priority-${member.id}`}>Priority</Label>
				<Input
					disabled={controlsDisabled}
					id={`pool-priority-${member.id}`}
					max={255}
					min={0}
					onChange={(event) =>
						updateMember(member.id, {
							priority: Number(event.target.value),
						})
					}
					type="number"
					value={member.priority}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={`pool-weight-${member.id}`}>Weight</Label>
				<Input
					disabled={controlsDisabled}
					id={`pool-weight-${member.id}`}
					max={65_535}
					min={0}
					onChange={(event) =>
						updateMember(member.id, {
							weight: Number(event.target.value),
						})
					}
					type="number"
					value={member.weight}
				/>
			</div>
			<div className="flex flex-col items-center gap-1">
				<Label htmlFor={`pool-enabled-${member.id}`}>On</Label>
				<Switch
					checked={member.enabled}
					disabled={controlsDisabled}
					id={`pool-enabled-${member.id}`}
					onCheckedChange={(enabled) => updateMember(member.id, { enabled })}
				/>
			</div>
			<Button
				aria-label={tl("Remove {provider} from pool", {
					provider: member.provider,
				})}
				disabled={controlsDisabled}
				onClick={() =>
					setMembers((current) =>
						current.filter((item) => item.id !== member.id)
					)
				}
				size="sm"
				variant="ghost"
			>
				Remove
			</Button>
			<div className="flex flex-col gap-1 sm:col-span-full">
				<div className="flex items-center gap-2">
					<Switch
						checked={member.last_resort ?? false}
						disabled={controlsDisabled}
						id={`pool-last-resort-${member.id}`}
						onCheckedChange={(lastResort) =>
							updateMember(member.id, { last_resort: lastResort })
						}
					/>
					<Label htmlFor={`pool-last-resort-${member.id}`}>Last resort</Label>
				</div>
				<p className="text-muted-foreground text-xs">
					Use after regular members are unavailable. Active sessions stay on
					this member while healthy.
				</p>
			</div>
		</div>
	);
}
