"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import type { AgentSettingsFormProps } from "./agent-edit-form-types.ts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

/** Connections tab: Composio actions, account access, and channels. */
export function AgentConnectionsPanel({
	props,
}: {
	props: AgentSettingsFormProps;
}) {
	const {
		channelsPanel,
		isLocked,
		composioConfigured,
		composioToolkit,
		composioToolkitItems,
		onComposioToolkitChange,
		composioActionsLoading,
		composioActions,
		selectedComposio,
		onToggleComposio,
		onSelectAllComposio,
		onClearComposio,
		identityPanel,
		accountAccessPanel,
	} = props;
	const tl = useLiteralMessages();

	return (
		<>
			{/* 5. Connections — Composio actions + Identities + Channels */}
			<SettingsSection
				caption={
					composioConfigured
						? "Attach third-party actions (sending email, creating issues, …) from your connected integrations."
						: "Add a Composio API key in Gateway → API keys, then connect accounts in Marketplace → Connections, to attach actions like sending email or creating issues."
				}
				headerAction={
					selectedComposio.size > 0 ? (
						<Badge variant="secondary">{selectedComposio.size}</Badge>
					) : undefined
				}
				title="Connections"
			>
				{composioConfigured ? (
					<SettingsCard className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="composio-toolkit">Integration</Label>
							<Select
								disabled={isLocked}
								items={composioToolkitItems.map((t) => ({
									value: t.id,
									label: t.label,
								}))}
								onValueChange={(v) => onComposioToolkitChange?.(v ?? null)}
								value={composioToolkit ?? ""}
							>
								<SelectTrigger className="w-full" id="composio-toolkit">
									<SelectValue placeholder="Pick an integration (Gmail, GitHub, …)" />
								</SelectTrigger>
								<SelectContent>
									{composioToolkitItems.map((t) => (
										<SelectItem key={t.id} value={t.id}>
											{t.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{composioToolkit ? (
							<div className="flex flex-col gap-2">
								{composioActions.length > 0 && !composioActionsLoading ? (
									<div className="flex items-center justify-between">
										<span className="text-muted-foreground text-xs">
											{composioActions.every((a) =>
												selectedComposio.has(a.name)
											)
												? "All tools enabled"
												: tl("{selected} of {total} selected", {
														selected: String(
															composioActions.filter((a) =>
																selectedComposio.has(a.name)
															).length
														),
														total: String(composioActions.length),
													})}
										</span>
										<div className="flex gap-2">
											<Button
												disabled={
													isLocked ||
													composioActions.every((a) =>
														selectedComposio.has(a.name)
													)
												}
												onClick={() => onSelectAllComposio?.()}
												size="sm"
												type="button"
												variant="outline"
											>
												All tools
											</Button>
											<Button
												disabled={
													isLocked ||
													!composioActions.some((a) =>
														selectedComposio.has(a.name)
													)
												}
												onClick={() => onClearComposio?.()}
												size="sm"
												type="button"
												variant="ghost"
											>
												Clear
											</Button>
										</div>
									</div>
								) : null}
								{composioActionsLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground text-xs">
										<Spinner className="size-3" />
										Loading actions…
									</div>
								) : null}
								{!composioActionsLoading && composioActions.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No actions found for this integration.
									</p>
								) : null}
								{!composioActionsLoading && composioActions.length > 0
									? composioActions.map((action) => {
											const checkId = `composio-${action.name}`;
											return (
												<div
													className="flex items-start gap-3"
													key={action.name}
												>
													<Checkbox
														checked={selectedComposio.has(action.name)}
														disabled={isLocked}
														id={checkId}
														onCheckedChange={() =>
															onToggleComposio?.(action.name)
														}
													/>
													<Label htmlFor={checkId} variant="agent-choice">
														<span className="font-medium">
															{action.displayName}
														</span>
														{action.description ? (
															<span className="block text-muted-foreground text-xs">
																{action.description}
															</span>
														) : null}
													</Label>
												</div>
											);
										})
									: null}
							</div>
						) : null}

						{selectedComposio.size > 0 ? (
							<div className="flex flex-wrap gap-1.5 border-t pt-3">
								{Array.from(selectedComposio).map((cname) => (
									<Badge key={cname} variant="outline">
										{cname}
										<button
											aria-label={tl("Remove {cname}", { cname })}
											className="text-muted-foreground hover:text-foreground"
											disabled={isLocked}
											onClick={() => onToggleComposio?.(cname)}
											type="button"
										>
											×
										</button>
									</Badge>
								))}
							</div>
						) : null}
					</SettingsCard>
				) : null}
			</SettingsSection>

			{accountAccessPanel ? (
				<div data-setting-id="agent.account-access">
					<SettingsSection
						caption="Which of your accounts and the agent's own accounts it may use. What is offered here follows its Identity setting."
						title="Account access"
					>
						{accountAccessPanel}
					</SettingsSection>
				</div>
			) : (
				identityPanel
			)}
			{channelsPanel}
		</>
	);
}
