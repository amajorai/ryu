import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { Dispatch, SetStateAction } from "react";
import type {
	ByokProvider,
	GatewayAccountStrategy,
	GatewayProviderAccount,
} from "@/src/lib/api/gateway.ts";
import { AccountEditor } from "./account-editor.tsx";

/** Additional accounts on this provider, each editable. */
export function ProviderAccountList({
	accountCount,
	accounts,
	canConfigure,
	handleRemove,
	label,
	onConfigure,
	onReplace,
	quotaRouting,
	readOnly,
	removingIndex,
	slug,
}: {
	accountCount: number;
	accounts: GatewayProviderAccount[] | undefined;
	canConfigure: boolean;
	handleRemove: (index: number) => Promise<void>;
	label: string;
	onConfigure:
		| ((slug: ByokProvider, account: GatewayProviderAccount) => Promise<void>)
		| undefined;
	onReplace:
		| ((
				slug: ByokProvider,
				account: GatewayProviderAccount,
				key: string
		  ) => Promise<void>)
		| undefined;
	quotaRouting: boolean;
	readOnly: boolean;
	removingIndex: number | null;
	slug: ByokProvider;
}) {
	const tl = useLiteralMessages();
	return !readOnly && accounts && onConfigure ? (
		<div className="flex flex-col gap-2">
			{accounts.map((account, index) => (
				<AccountEditor
					account={account}
					disabled={!canConfigure}
					key={account.id}
					label={label}
					onRemove={() => handleRemove(index)}
					onReplace={
						onReplace ? (key) => onReplace(slug, account, key) : undefined
					}
					onSave={(updated) => onConfigure(slug, updated)}
					quotaRouting={quotaRouting}
					slug={slug}
				/>
			))}
		</div>
	) : !readOnly && accountCount > 0 ? (
		<div className="flex flex-col gap-1 text-xs">
			{Array.from({ length: accountCount }, (_, index) => (
				<div
					className="flex items-center justify-between border-border border-t py-1"
					key={`${slug}-${index}`}
				>
					<span>
						{tl("Account {number} · key hidden", { number: index + 1 })}
					</span>
					<Button
						aria-label={tl("Remove {label} account {number}", {
							label,
							number: index + 1,
						})}
						disabled={!canConfigure}
						loading={removingIndex === index}
						onClick={() => handleRemove(index)}
						size="sm"
						variant="ghost"
					>
						Remove
					</Button>
				</div>
			))}
		</div>
	) : null;
}

/** How requests are spread across this provider's accounts. */
export function ProviderAccountStrategy({
	accountCount,
	accountStrategy,
	canConfigure,
	handleStrategyChange,
	handleThresholdChange,
	onDrainThresholdChange,
	onStrategyChange,
	quotaRouting,
	readOnly,
	setThresholdDraft,
	slug,
	strategySaving,
	thresholdDraft,
	thresholdSaving,
}: {
	accountCount: number;
	accountStrategy: GatewayAccountStrategy | undefined;
	canConfigure: boolean;
	handleStrategyChange: (strategy: GatewayAccountStrategy) => Promise<void>;
	handleThresholdChange: () => Promise<void>;
	onDrainThresholdChange:
		| ((slug: ByokProvider, percent: number) => Promise<void>)
		| undefined;
	onStrategyChange:
		| ((slug: ByokProvider, strategy: GatewayAccountStrategy) => Promise<void>)
		| undefined;
	quotaRouting: boolean;
	readOnly: boolean;
	setThresholdDraft: Dispatch<SetStateAction<string>>;
	slug: ByokProvider;
	strategySaving: boolean;
	thresholdDraft: string;
	thresholdSaving: boolean;
}) {
	return !readOnly &&
		onStrategyChange &&
		(accountCount > 1 ||
			(accountStrategy && accountStrategy !== "round_robin")) ? (
		<div className="space-y-1.5 border-border border-t pt-3">
			<label className="text-xs" htmlFor={`${slug}-account-strategy`}>
				Account routing
			</label>
			<Select<GatewayAccountStrategy>
				disabled={!canConfigure || strategySaving}
				items={
					quotaRouting
						? [
								{ value: "round_robin", label: "Round robin" },
								{ value: "quota_first", label: "Quota first" },
								{ value: "fill_first", label: "Fill first" },
								{ value: "reset_first", label: "Reset first" },
							]
						: [
								{ value: "round_robin", label: "Round robin" },
								{ value: "fill_first", label: "Fill first" },
							]
				}
				onValueChange={(value) => value && handleStrategyChange(value)}
				value={accountStrategy ?? "round_robin"}
			>
				<SelectTrigger id={`${slug}-account-strategy`}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent
					align="start"
					alignItemWithTrigger={false}
					className="min-w-48"
				>
					<SelectItem value="round_robin">Round robin</SelectItem>
					{quotaRouting ? (
						<SelectItem value="quota_first">Quota first</SelectItem>
					) : null}
					<SelectItem value="fill_first">Fill first</SelectItem>
					{quotaRouting ? (
						<SelectItem value="reset_first">Reset first</SelectItem>
					) : null}
				</SelectContent>
			</Select>
			<p className="text-muted-foreground text-xs">
				{accountStrategy === "quota_first"
					? "New chats prefer the key with the lowest observed rate-limit usage. Missing or stale per-key limits fall back to round robin."
					: accountStrategy === "fill_first"
						? quotaRouting
							? "New chats stay on one key until its observed rate-limit usage reaches the drain point or it cools down."
							: "New chats stay on one eligible key until rate-limit or account-credit rejection."
						: accountStrategy === "reset_first"
							? "New chats prefer a key with a reported upcoming rate-limit reset and available capacity. Missing or stale limits fall back to round robin."
							: "New chats rotate between eligible keys in the highest priority tier."}
				{
					" Existing chats with a session ID keep their healthy key for prompt caching."
				}
			</p>
			{accountStrategy === "fill_first" && onDrainThresholdChange ? (
				<div className="flex items-end gap-2">
					<div className="space-y-1">
						<label className="text-xs" htmlFor={`${slug}-drain-threshold`}>
							Drain at used quota (%)
						</label>
						<Input
							disabled={!canConfigure || thresholdSaving}
							id={`${slug}-drain-threshold`}
							max={100}
							min={1}
							onChange={(event) => setThresholdDraft(event.target.value)}
							type="number"
							value={thresholdDraft}
						/>
					</div>
					<Button
						disabled={!canConfigure || thresholdSaving}
						loading={thresholdSaving}
						onClick={handleThresholdChange}
						size="sm"
						variant="outline"
					>
						Save
					</Button>
				</div>
			) : null}
		</div>
	) : null;
}
