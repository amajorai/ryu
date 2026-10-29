"use client";

import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@ryu/ui/components/alert";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Label } from "@ryu/ui/components/label";
import { SkeletonRows } from "@ryu/ui/components/skeleton";
import { Switch } from "@ryu/ui/components/switch";
import type { AgentIdentityMode } from "@ryuhq/core-client/agents";
import type { ReactNode } from "react";
import {
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "./agent-identity-mode.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
} from "./settings-items.tsx";

// Account access, as a data-free view: which accounts one agent may use.
//
// The desktop's `AgentAccountAccessPanel` loads the accounts (connected apps,
// model providers, MCP sign-ins, saved-key services, Identity Vault profiles,
// the agent's own logins and apps), works out Core's launch answer, and renders
// this view with the rows it built. The storyboard renders the same view from
// fixtures, so both show one layout.
//
// `accountAccess` is Core's `account_access` allowlist: `null` is no limit
// (every row shows ticked and locked), a list is the explicit selection. The
// Treg switch is a platform route, not one of the user's accounts, so it shows
// in every mode. Groups follow the identity mode; a hidden group gets one line
// saying why, so the selection does not look lost.

/** The Treg switch's allowlist key. Keep in step with `apps/core/src/agent_access.rs`. */
export const TREG_ACCOUNT_KEY = "platform:treg";
/** Ghost controlling your desktop, and what Shadow captured from it. */
export const DESKTOP_ACCOUNT_KEY = "platform:desktop";

export interface AccountAccessRow {
	detail?: string;
	/** The account id behind the key, for row actions. */
	id?: string;
	key: string;
	status?: { label: string; muted: boolean };
	title: string;
}

function GroupHeading({ children }: { children: ReactNode }) {
	return (
		<h4 className="px-3.5 font-medium text-foreground/70 text-xs">
			{children}
		</h4>
	);
}

/** One checkbox per account; every box is ticked and locked while unrestricted. */
export function AccountAccessRows({
	accountAccess,
	disabled,
	empty,
	loading,
	onToggle,
	rows,
	trailing,
}: {
	accountAccess: readonly string[] | null;
	disabled: boolean;
	empty: ReactNode;
	loading: boolean;
	onToggle: (key: string, allowed: boolean) => void;
	rows: readonly AccountAccessRow[];
	/** An action shown at the end of each row. */
	trailing?: (row: AccountAccessRow) => ReactNode;
}) {
	if (loading) {
		return <SkeletonRows label="Loading accounts…" spacing="comfortable" />;
	}
	if (rows.length === 0) {
		return <p className="text-muted-foreground text-sm">{empty}</p>;
	}
	const unrestricted = accountAccess === null;
	return (
		<div className="flex flex-col gap-2">
			{rows.map((row) => {
				const checkId = `account-access-${row.key}`;
				return (
					<div className="flex items-start gap-3" key={row.key}>
						<Checkbox
							checked={unrestricted || accountAccess.includes(row.key)}
							disabled={disabled || unrestricted}
							id={checkId}
							onCheckedChange={(checked) => onToggle(row.key, checked === true)}
						/>
						<Label htmlFor={checkId} variant="agent-choice">
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{row.title}</span>
									{row.status ? (
										<Badge
											size="compact"
											variant={row.status.muted ? "outline" : "secondary"}
										>
											{row.status.label}
										</Badge>
									) : null}
								</span>
								{row.detail ? (
									<span className="truncate text-muted-foreground text-xs">
										{row.detail}
									</span>
								) : null}
							</span>
						</Label>
						{trailing ? (
							<div className="ml-auto shrink-0">{trailing(row)}</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/**
 * The frame of "Agent's own accounts → Connected apps": apps connected to the
 * agent's own identity. The host supplies the Connect action, the app picker
 * while connecting, and the body (rows, or why there are none).
 */
export function AgentOwnConnectedAppsCard({
	children,
	connectAction,
	picker,
}: {
	children: ReactNode;
	connectAction?: ReactNode;
	picker?: ReactNode;
}) {
	return (
		<SettingsCard className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<p className="font-medium text-sm">Connected apps</p>
					<p className="text-muted-foreground text-xs leading-snug">
						Apps connected to this agent's own identity, not to yours. Only this
						agent uses them.
					</p>
				</div>
				{connectAction}
			</div>
			{picker}
			{children}
		</SettingsCard>
	);
}

interface RowSource {
	loading: boolean;
	rows: readonly AccountAccessRow[];
}

export interface AgentAccountAccessViewProps {
	accountAccess: readonly string[] | null;
	/** True while accounts a fresh limit would start from are still loading. */
	accountsLoading?: boolean;
	/** Your connected Composio apps; `configured` is false when Composio is not
	 *  set up on the node. */
	connectedApps: RowSource & { configured: boolean };
	disabled: boolean;
	/** Core's reason the engine would not start under this access, if any. */
	engineRefusal?: string | null;
	/** Identity Vault profiles, always chosen one by one. */
	identities: {
		loading: boolean;
		onToggle: (profileId: string) => void;
		profileIds: readonly string[];
		selected: ReadonlySet<string>;
	};
	identityMode: AgentIdentityMode;
	/** MCP OAuth sign-ins; `null` hides the card (no app signs in to MCP). */
	mcpSignIns: RowSource | null;
	modelProviders: RowSource & { error: boolean };
	/** The no-sandbox line, when Core says this computer has no sandbox. */
	noSandboxNote?: string | null;
	onConnectApp?: () => void;
	onLimitChange: (limited: boolean) => void;
	onOpenVault?: () => void;
	onToggle: (key: string, allowed: boolean) => void;
	/** The agent's own connected apps card (see `AgentOwnConnectedAppsCard`). */
	ownConnectedApps: ReactNode;
	/** The agent's own website logins; `unsaved` is a brand-new agent. */
	ownLogins: RowSource & { error: boolean; unsaved: boolean };
	savedKeys: RowSource & { error: boolean };
}

export function AgentAccountAccessView({
	accountAccess,
	accountsLoading = false,
	connectedApps,
	disabled,
	engineRefusal = null,
	identities,
	identityMode,
	mcpSignIns,
	modelProviders,
	noSandboxNote = null,
	onConnectApp,
	onLimitChange,
	onOpenVault,
	onToggle,
	ownConnectedApps,
	ownLogins,
	savedKeys,
}: AgentAccountAccessViewProps) {
	const showYours = modeUsesYourAccounts(identityMode);
	const showOwn = modeHasOwnAccounts(identityMode);
	const limited = accountAccess !== null;

	let ownLoginsBody: ReactNode;
	if (ownLogins.unsaved) {
		ownLoginsBody = (
			<p className="text-muted-foreground text-sm">
				Save the agent first. It can then sign up for accounts of its own.
			</p>
		);
	} else if (ownLogins.error) {
		ownLoginsBody = (
			<p className="text-muted-foreground text-sm">
				Couldn't load this agent's accounts.
			</p>
		);
	} else {
		ownLoginsBody = (
			<AccountAccessRows
				accountAccess={accountAccess}
				disabled={disabled}
				empty="No accounts yet. The agent adds one when it signs up for a site."
				loading={ownLogins.loading}
				onToggle={onToggle}
				rows={ownLogins.rows}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{engineRefusal ? (
				<Alert variant="destructive">
					<AlertDescription>{engineRefusal}</AlertDescription>
				</Alert>
			) : null}
			{noSandboxNote ? (
				<p className="px-3.5 text-muted-foreground text-xs leading-snug">
					{noSandboxNote}
				</p>
			) : null}
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Limit to selected accounts"
							checked={limited}
							disabled={disabled || (!limited && accountsLoading)}
							onCheckedChange={onLimitChange}
						/>
					}
					description={
						limited
							? "Only the accounts ticked below can be used. Accounts you connect later are not added automatically."
							: "Unrestricted: the agent may use every account below. Turn this on to choose."
					}
					settingsId="agent.account-access.limit"
					title="Limit to selected accounts"
				/>
				<SettingsItem
					actions={
						<Switch
							aria-label="Allow Treg"
							checked={!limited || accountAccess.includes(TREG_ACCOUNT_KEY)}
							disabled={disabled || !limited}
							onCheckedChange={(on) => onToggle(TREG_ACCOUNT_KEY, on)}
						/>
					}
					description="Metered tool APIs through Ryu's Treg router. Applies to the Treg calls an app makes for this agent, including calls it makes later for work the agent set up."
					settingsId="agent.account-access.treg"
					title="Treg"
				/>
			</SettingsGroup>

			<div className="flex flex-col gap-2">
				<GroupHeading>Your accounts</GroupHeading>
				{showYours ? (
					<div className="flex flex-col gap-3">
						<SettingsCard className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-3">
								<p className="font-medium text-sm">Connected apps</p>
								{onConnectApp ? (
									<Button onClick={onConnectApp} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
										Connect an app
									</Button>
								) : null}
							</div>
							<AccountAccessRows
								accountAccess={accountAccess}
								disabled={disabled}
								empty={
									connectedApps.configured
										? "No connected apps yet."
										: "Composio isn't set up on this node."
								}
								loading={connectedApps.configured && connectedApps.loading}
								onToggle={onToggle}
								rows={connectedApps.rows}
							/>
						</SettingsCard>

						<SettingsCard className="flex flex-col gap-3">
							<p className="font-medium text-sm">Model providers</p>
							<p className="text-muted-foreground text-xs leading-snug">
								Your chat model provider keys and sign-ins this agent's models
								may run on when Ryu routes them. Ryu credits and local models
								are always available.
							</p>
							{modelProviders.error ? (
								<p className="text-muted-foreground text-sm">
									Couldn't load your model providers.
								</p>
							) : (
								<AccountAccessRows
									accountAccess={accountAccess}
									disabled={disabled}
									empty="No provider keys yet."
									loading={modelProviders.loading}
									onToggle={onToggle}
									rows={modelProviders.rows}
								/>
							)}
						</SettingsCard>

						{mcpSignIns ? (
							<SettingsCard className="flex flex-col gap-3">
								<p className="font-medium text-sm">MCP sign-ins</p>
								<AccountAccessRows
									accountAccess={accountAccess}
									disabled={disabled}
									empty="No MCP servers signed in yet."
									loading={mcpSignIns.loading}
									onToggle={onToggle}
									rows={mcpSignIns.rows}
								/>
							</SettingsCard>
						) : null}

						<SettingsCard className="flex flex-col gap-3">
							<p className="font-medium text-sm">
								Services using your saved keys
							</p>
							<p className="text-muted-foreground text-xs leading-snug">
								MCP servers and app tools that call out with an API key or
								secret you saved.
							</p>
							{savedKeys.error ? (
								<p className="text-muted-foreground text-sm">
									Couldn't load your MCP servers.
								</p>
							) : (
								<AccountAccessRows
									accountAccess={accountAccess}
									disabled={disabled}
									empty="No services use your saved keys yet."
									loading={savedKeys.loading}
									onToggle={onToggle}
									rows={savedKeys.rows}
								/>
							)}
						</SettingsCard>

						<SettingsCard className="flex flex-col gap-3">
							<AccountAccessRows
								accountAccess={accountAccess}
								disabled={disabled}
								empty={null}
								loading={false}
								onToggle={onToggle}
								rows={[
									{
										detail:
											"Ghost using your mouse and keyboard, and what Shadow captured.",
										key: DESKTOP_ACCOUNT_KEY,
										title: "Control of your desktop",
									},
								]}
							/>
						</SettingsCard>

						<div data-setting-id="agent.identities">
							<SettingsCard className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-3">
									<p className="font-medium text-sm">Identities</p>
									{identities.selected.size > 0 ? (
										<Badge variant="secondary">
											{identities.selected.size}
										</Badge>
									) : null}
								</div>
								<p className="text-muted-foreground text-xs leading-snug">
									Identity Vault profiles this agent may act as on their
									connected domains. Leave all unchecked to bind none. These are
									always chosen one by one, whatever the limit above.
									Credentials are encrypted and never sent to the model.
								</p>
								{identities.loading ? (
									<SkeletonRows
										label="Loading profiles…"
										spacing="comfortable"
									/>
								) : null}
								{!identities.loading && identities.profileIds.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No identity profiles yet. Create a connection on the
										Identities page to define one.
									</p>
								) : null}
								{!identities.loading && identities.profileIds.length > 0 ? (
									<div className="flex flex-col gap-2">
										{identities.profileIds.map((profileId) => {
											const checkId = `identity-${profileId}`;
											return (
												<div className="flex items-start gap-3" key={profileId}>
													<Checkbox
														checked={identities.selected.has(profileId)}
														disabled={disabled}
														id={checkId}
														onCheckedChange={() =>
															identities.onToggle(profileId)
														}
													/>
													<Label htmlFor={checkId} variant="agent-choice">
														<span className="font-medium">{profileId}</span>
													</Label>
												</div>
											);
										})}
									</div>
								) : null}
							</SettingsCard>
						</div>
					</div>
				) : (
					<p className="px-3.5 text-muted-foreground text-xs leading-snug">
						This agent has its own identity, so it never uses your accounts.
						Models Ryu routes for it run on Ryu credits or a local model, not
						your provider keys. Engines that use your own sign-in (Claude Code,
						Codex on ChatGPT, Gemini CLI, Kiro), and engines Ryu can't route
						through its Gateway, don't start for it. It can't use services that
						need your saved keys or control your desktop. Choose Acts as you or
						Both under Identity to allow your accounts.
					</p>
				)}
			</div>

			<div className="flex flex-col gap-2">
				<GroupHeading>Agent's own accounts</GroupHeading>
				{showOwn ? (
					<div className="flex flex-col gap-3">
						<SettingsCard className="flex flex-col gap-3">
							<div className="flex items-center justify-between gap-3">
								<p className="text-muted-foreground text-xs leading-snug">
									Website logins this agent created for itself. They live in its
									own Vault folder and only it can fill them.
								</p>
								{onOpenVault ? (
									<Button onClick={onOpenVault} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
										Open Vault
									</Button>
								) : null}
							</div>
							{ownLoginsBody}
						</SettingsCard>
						{ownConnectedApps}
					</div>
				) : (
					<p className="px-3.5 text-muted-foreground text-xs leading-snug">
						This agent acts as you, so it has no accounts of its own. Choose Its
						own identity or Both under Identity to give it some.
					</p>
				)}
			</div>
		</div>
	);
}
