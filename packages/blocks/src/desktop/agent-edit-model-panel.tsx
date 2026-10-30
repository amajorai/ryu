"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import type { AgentSettingsFormProps } from "./agent-edit-form-types.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

/** The engine/model panel: its own tab, or inline under Behavior in the simple
 *  editor. */
export function AgentModelPanel({ props }: { props: AgentSettingsFormProps }) {
	const {
		isLocked,
		onAddMoreAgentProviders,
		chatModel,
		chatModelPicker,
		engineOptions,
		onChatModelChange,
		chatSlotDisabled,
		showAcpCommand,
		acpCommand,
		acpSessionPanel,
		onAcpCommandChange,
		piConfig,
		claudeConfig,
		codexConfig,
		gatewayRoutingConfig,
		budgetPanel,
	} = props;

	return (
		<>
			{/* 2. Model & provider */}
			<SettingsSection
				caption="The engine and model used for all chat turns."
				title="Model & provider"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							chatModelPicker ??
							(engineOptions.length === 0 ? (
								<span className="text-muted-foreground text-xs">
									No options installed yet.
								</span>
							) : (
								<Select
									disabled={chatSlotDisabled}
									items={engineOptions.map((opt) => ({
										value: opt.id,
										label: opt.label,
									}))}
									onValueChange={(v) => onChatModelChange?.(v ?? "")}
									value={chatModel}
								>
									<SelectTrigger
										appearance="editor-row"
										className="w-64 shrink-0"
										id="slot-chat-model"
									>
										<SelectValue placeholder="Select chat model" />
									</SelectTrigger>
									<SelectContent>
										{engineOptions.map((opt) => (
											<SelectItem key={opt.id} value={opt.id}>
												{opt.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							))
						}
						title="Chat model"
					/>
					{onAddMoreAgentProviders ? (
						<Button
							appearance="agent-integration-option"
							onClick={onAddMoreAgentProviders}
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add more agent providers
						</Button>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			{showAcpCommand ? (
				<SettingsSection
					caption={
						<>
							Type the command that launches your agent on this computer. For
							example: <code>goose acp</code>, <code>opencode acp</code>, or{" "}
							<code>npx -y my-agent --acp</code>.
						</>
					}
					title="Command to start your agent"
				>
					<SettingsCard>
						<label className="sr-only" htmlFor="acp-command">
							Command to start your agent
						</label>
						<input
							className="w-full rounded-lg border bg-card px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
							disabled={isLocked}
							id="acp-command"
							onChange={(e) => onAcpCommandChange?.(e.target.value)}
							placeholder="goose acp"
							spellCheck={false}
							value={acpCommand}
						/>
					</SettingsCard>
				</SettingsSection>
			) : null}

			{piConfig}
			{claudeConfig}
			{codexConfig}
			{budgetPanel}
			{gatewayRoutingConfig}
			{acpSessionPanel}
		</>
	);
}
