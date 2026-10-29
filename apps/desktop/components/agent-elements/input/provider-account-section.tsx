"use client";

import {
	Delete02Icon,
	PencilEdit01Icon,
	SquareLock01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import "./universal-picker-body.module.css";
import { useState } from "react";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";

/** A provider or ACP account as exposed by Core — labels only, never credentials. */
export interface ProviderAccount {
	accountId: string;
	/** Whether this is the account used by the current Ryu configuration. */
	active: boolean;
	/** Whether this account is the selected BYOK account for the Gateway. */
	gatewayActive?: boolean;
	/** "api_key" | "oauth" | "opaque". */
	kind: string;
	/** Display name (email, provider label, or "Account N"). */
	label: string;
	/** Core blocked this credential generation until the user signs in again. */
	needsReauth?: boolean;
	/** Provider id for managed-Pi accounts aggregated under the Ryu agent. */
	provider?: string;
}

export type ProviderAccountTarget = "gateway" | "self";

interface AccountTargetItemProps {
	description: string;
	disabled?: boolean;
	isActive: boolean;
	label: string;
	onSelect: () => void;
}

function AccountTargetItem({
	disabled = false,
	isActive,
	description,
	label,
	onSelect,
}: AccountTargetItemProps) {
	const commandNavigation = useProviderCommandNavigation();
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={isActive}
				disabled={disabled}
				onSelect={() => {
					if (disabled) {
						return;
					}
					onSelect();
					commandNavigation.close();
				}}
			>
				<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
					<span className="truncate">{label}</span>
					<span className="font-normal text-muted-foreground text-xs">
						{description}
					</span>
				</span>
			</CommandItem>
		);
	}

	return (
		<DropdownMenuItem
			className="flex-col items-start"
			disabled={disabled}
			onClick={onSelect}
			spacing="tight"
		>
			<span className="flex w-full items-center gap-2">
				<span className="flex-1 truncate">{label}</span>
				{isActive && (
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={14}
						strokeWidth={2}
					/>
				)}
			</span>
			<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
				{description}
			</span>
		</DropdownMenuItem>
	);
}

function AccountTargetPage({
	account,
	canSetGateway,
	gatewaySupported,
	onSwitch,
}: {
	account: ProviderAccount;
	canSetGateway: boolean;
	gatewaySupported: boolean;
	onSwitch: (account: ProviderAccount, target: ProviderAccountTarget) => void;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<AccountTargetItem
				description="Switch the account used by your Ryu session."
				isActive={account.active}
				label="Use for yourself"
				onSelect={() => onSwitch(account, "self")}
			/>
			{gatewaySupported && account.kind === "api_key" && (
				<AccountTargetItem
					description={
						canSetGateway
							? "Make this the shared Gateway account for this provider."
							: "Requires the gateway.configure admin permission."
					}
					disabled={!canSetGateway}
					isActive={account.gatewayActive === true}
					label={
						canSetGateway ? "Set for Gateway" : "Set for Gateway (admin only)"
					}
					onSelect={() => onSwitch(account, "gateway")}
				/>
			)}
		</div>
	);
}

function AccountStatus({
	account,
	gatewaySupported,
}: {
	account: ProviderAccount;
	gatewaySupported: boolean;
}) {
	const gatewayActive =
		gatewaySupported && account.kind === "api_key" && account.gatewayActive;
	const statuses = [
		account.active ? "You" : null,
		gatewayActive ? "Gateway" : null,
		account.needsReauth ? "Sign in again" : null,
	].filter(Boolean);
	if (statuses.length === 0) {
		return null;
	}
	return (
		<span
			className={cn(
				"type-compact shrink-0 text-muted-foreground",
				account.needsReauth && "text-destructive"
			)}
		>
			{statuses.join(" · ")}
		</span>
	);
}

/** One account row with an explicit self/Gateway target and a remove action. */
function AccountRow({
	account,
	canSetGateway,
	gatewaySupported,
	onRename,
	onRemove,
	onSwitch,
}: {
	account: ProviderAccount;
	canSetGateway: boolean;
	gatewaySupported: boolean;
	onRename?: (accountId: string, label: string) => Promise<boolean>;
	onRemove: (accountId: string) => void;
	onSwitch: (account: ProviderAccount, target: ProviderAccountTarget) => void;
}) {
	const commandNavigation = useProviderCommandNavigation();
	const tl = useLiteralMessages();
	const [editingLabel, setEditingLabel] = useState(false);
	const [labelDraft, setLabelDraft] = useState(account.label);
	const [savingLabel, setSavingLabel] = useState(false);
	const selected =
		account.active ||
		(gatewaySupported &&
			account.kind === "api_key" &&
			account.gatewayActive === true);
	const targetPage = (
		<AccountTargetPage
			account={account}
			canSetGateway={canSetGateway}
			gatewaySupported={gatewaySupported}
			onSwitch={onSwitch}
		/>
	);
	const label = account.provider
		? `${account.label} · ${account.provider}`
		: account.label;
	const saveLabel = async () => {
		const nextLabel = labelDraft.trim();
		if (!onRename) {
			return;
		}
		if (!nextLabel || nextLabel === account.label) {
			return;
		}

		setSavingLabel(true);
		try {
			if (await onRename(account.accountId, nextLabel)) {
				setEditingLabel(false);
			}
		} finally {
			setSavingLabel(false);
		}
	};

	if (editingLabel) {
		return (
			<form
				className="flex items-center gap-1 px-1 py-1"
				onSubmit={(event) => {
					event.preventDefault();
					void saveLabel();
				}}
			>
				<Input
					aria-label={tl("Label for {label}", { label: account.label })}
					autoFocus
					className="h-7 min-w-0 flex-1"
					maxLength={80}
					onChange={(event) => setLabelDraft(event.target.value)}
					onKeyDown={(event) => event.stopPropagation()}
					value={labelDraft}
				/>
				<Button
					disabled={
						savingLabel ||
						labelDraft.trim() === "" ||
						labelDraft.trim() === account.label
					}
					size="sm"
					type="submit"
				>
					Save
				</Button>
				<Button
					disabled={savingLabel}
					onClick={() => setEditingLabel(false)}
					size="sm"
					type="button"
					variant="ghost"
				>
					Cancel
				</Button>
			</form>
		);
	}

	if (commandNavigation) {
		return (
			<div className="flex items-center gap-1">
				<CommandItem
					className="min-w-0 flex-1"
					data-checked={selected}
					onSelect={() =>
						commandNavigation.push({
							body: targetPage,
							title: `Set ${account.label}`,
						})
					}
				>
					<span className="text-(length:--text-detail) min-w-0 flex-1 truncate">
						{label}
					</span>
					<AccountStatus
						account={account}
						gatewaySupported={gatewaySupported}
					/>
				</CommandItem>
				{onRename ? (
					<AccountRenameButton
						account={account}
						onRename={() => {
							setLabelDraft(account.label);
							setEditingLabel(true);
						}}
					/>
				) : null}
				<AccountRemoveButton account={account} onRemove={onRemove} />
			</div>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<DropdownMenu>
				<DropdownMenuTrigger
					className="flex min-w-0 flex-1 items-center"
					selected={selected}
					variant="account-row"
				>
					<span className="text-(length:--text-detail) min-w-0 flex-1 truncate">
						{label}
					</span>
					<AccountStatus
						account={account}
						gatewaySupported={gatewaySupported}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					className="min-w-[220px]"
					data-desktop-picker-inset="true"
				>
					{targetPage}
				</DropdownMenuContent>
			</DropdownMenu>
			{onRename ? (
				<AccountRenameButton
					account={account}
					onRename={() => {
						setLabelDraft(account.label);
						setEditingLabel(true);
					}}
				/>
			) : null}
			<AccountRemoveButton account={account} onRemove={onRemove} />
		</div>
	);
}

function AccountRenameButton({
	account,
	onRename,
}: {
	account: ProviderAccount;
	onRename: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Button
			aria-label={tl("Rename account {label}", { label: account.label })}
			className="shrink-0"
			onClick={(event) => {
				event.stopPropagation();
				onRename();
			}}
			size="icon-xs"
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon
				className="text-muted-foreground/70 hover:text-foreground"
				icon={PencilEdit01Icon}
				size={12}
				strokeWidth={2}
			/>
		</Button>
	);
}

function AccountRemoveButton({
	account,
	onRemove,
}: {
	account: ProviderAccount;
	onRemove: (accountId: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Button
			aria-label={tl("Remove {label}", { label: account.label })}
			className="shrink-0"
			onClick={(event) => {
				event.stopPropagation();
				onRemove(account.accountId);
			}}
			size="icon-xs"
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon
				className="text-muted-foreground/70 hover:text-foreground"
				icon={Delete02Icon}
				size={12}
				strokeWidth={2}
			/>
		</Button>
	);
}

/** The account section shared by provider settings and the composer picker. */
export function ProviderAccountSection({
	accounts,
	canSetGateway = true,
	gatewaySupported = false,
	onRename,
	onRemove,
	onSwitch,
}: {
	accounts: ProviderAccount[];
	canSetGateway?: boolean;
	gatewaySupported?: boolean;
	onRename?: (accountId: string, label: string) => Promise<boolean>;
	onRemove: (accountId: string) => void;
	onSwitch: (account: ProviderAccount, target: ProviderAccountTarget) => void;
}) {
	if (accounts.length === 0) {
		return null;
	}
	return (
		<div className="border-border/50 border-t pt-1">
			<div className="type-caption flex items-center gap-1 px-3 pt-1 pb-0.5 font-medium text-muted-foreground uppercase tracking-wide">
				<span>Accounts</span>
				{gatewaySupported && !canSetGateway && (
					<HugeiconsIcon
						aria-label="Gateway account changes require admin access"
						className="text-muted-foreground/70"
						icon={SquareLock01Icon}
						size={12}
					/>
				)}
			</div>
			{accounts.map((account) => (
				<AccountRow
					account={account}
					canSetGateway={canSetGateway}
					gatewaySupported={gatewaySupported && account.kind === "api_key"}
					key={account.accountId}
					onRemove={onRemove}
					onRename={onRename}
					onSwitch={onSwitch}
				/>
			))}
		</div>
	);
}
