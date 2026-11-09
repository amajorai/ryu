import { Cancel01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { activeLocale, dateFormatter } from "@ryu/i18n/core";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import type { PairedDevice } from "@/src/lib/api/paired-phones.ts";
import { presenceAgo, relativeTimeAgo } from "@/src/lib/time.ts";
import { RowTitle } from "./ConnectionsTab-row-title.tsx";
import { SettingsItem } from "./shared/settings-items.tsx";

/** What a paired-phone row can ask its section to do. */
export interface PairedPhoneActions {
	approve: (device: PairedDevice) => void;
	forget: (device: PairedDevice) => void;
	rename: (device: PairedDevice, label: string) => void;
	revokeGrant: (device: PairedDevice, tool: string) => void;
}

function platformLabel(platform: string): string {
	switch (platform) {
		case "ios":
			return "iPhone";
		case "android":
			return "Android";
		default:
			return platform || "Phone";
	}
}

function RenameField({
	busy,
	device,
	onCancel,
	onSave,
}: {
	busy: boolean;
	device: PairedDevice;
	onCancel: () => void;
	onSave: (label: string) => void;
}) {
	const tl = useLiteralMessages();
	const [label, setLabel] = useState(device.label);
	const trimmed = label.trim();
	return (
		<form
			className="flex items-center gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (trimmed && trimmed !== device.label) {
					onSave(trimmed);
				}
			}}
		>
			<Input
				aria-label={tl("New name for {name}", { name: device.label })}
				autoFocus
				disabled={busy}
				maxLength={64}
				onChange={(event) => setLabel(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						onCancel();
					}
				}}
				value={label}
			/>
			<Button
				disabled={busy || !trimmed || trimmed === device.label}
				size="sm"
				type="submit"
			>
				Save
			</Button>
			<Button onClick={onCancel} size="sm" type="button" variant="ghost">
				Cancel
			</Button>
		</form>
	);
}

function GrantChips({
	busy,
	device,
	onRevoke,
}: {
	busy: boolean;
	device: PairedDevice;
	onRevoke: (tool: string) => void;
}) {
	const tl = useLiteralMessages();
	if (device.always_allowed.length === 0) {
		return null;
	}
	return (
		<ul
			aria-label={tl("Always allowed on {name}", { name: device.label })}
			className="mt-2 flex flex-wrap gap-1.5"
		>
			{device.always_allowed.map((tool) => (
				<li key={tool}>
					<Badge className="gap-1 font-mono" variant="secondary">
						{tool}
						<button
							aria-label={tl("Revoke Always allow for {tool}", { tool })}
							className="rounded-sm opacity-70 hover:opacity-100 disabled:opacity-40"
							disabled={busy}
							onClick={() => onRevoke(tool)}
							type="button"
						>
							<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
						</button>
					</Badge>
				</li>
			))}
		</ul>
	);
}

function ForgetButton({
	busy,
	device,
	onForget,
}: {
	busy: boolean;
	device: PairedDevice;
	onForget: () => void;
}) {
	const tl = useLiteralMessages();
	const pending = device.state === "pending";
	const [open, setOpen] = useState(false);
	return (
		<AlertDialog onOpenChange={setOpen} open={open}>
			<AlertDialogTrigger
				render={
					<Button
						aria-label={
							pending
								? tl("Deny {name}", { name: device.label })
								: tl("Forget {name}", { name: device.label })
						}
						disabled={busy}
						size="sm"
						variant="ghost"
					/>
				}
			>
				{pending ? "Deny" : "Forget"}
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{pending
							? tl("Deny {name}?", { name: device.label })
							: tl("Forget {name}?", { name: device.label })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{pending
							? "The phone's pairing request is removed. It can ask again from the Ryu app."
							: "Ryu stops using apps on this phone and removes its key and Always allow grants. Pair it again from the Ryu app to reconnect."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							setOpen(false);
							onForget();
						}}
					>
						{pending ? "Deny" : "Forget"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Characters of the device id shown as the check code in the approve dialog. */
const CHECK_CODE_LENGTH = 6;

/** The trailing characters of a device id, for comparing against the phone. */
export function pairingCheckCode(deviceId: string): string {
	return deviceId.slice(-CHECK_CODE_LENGTH).toUpperCase();
}

function requestedAt(pairedAtMs: number): string {
	if (!(Number.isFinite(pairedAtMs) && pairedAtMs > 0)) {
		return "";
	}
	const absolute = dateFormatter(activeLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(pairedAtMs));
	return `${absolute} (${relativeTimeAgo(pairedAtMs)})`;
}

/**
 * Approve a pending pairing only after the owner compares what the phone sent
 * with the phone in their hand. The label is chosen by the phone, so the
 * dialog also shows the platform, app, request time and a check code taken
 * from the device id.
 */
function ApproveButton({
	busy,
	canApprove,
	device,
	onApprove,
}: {
	busy: boolean;
	canApprove: boolean;
	device: PairedDevice;
	onApprove: () => void;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const details: [string, string][] = [
		[tl("Platform"), tl(platformLabel(device.platform))],
		[tl("App"), device.app || "—"],
		[tl("Requested"), requestedAt(device.paired_at_ms) || "—"],
		[tl("Check code"), pairingCheckCode(device.device_id)],
	];
	return (
		<AlertDialog onOpenChange={setOpen} open={open}>
			<AlertDialogTrigger
				render={
					<Button
						aria-label={tl("Approve {name}", { name: device.label })}
						disabled={busy || !canApprove}
						size="sm"
						title={
							canApprove
								? undefined
								: tl("Approve from the computer that runs this node.")
						}
					/>
				}
			>
				Approve
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{tl("Approve {name}?", { name: device.label })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						Approve only a phone you are holding that asked to pair just now.
						The name is chosen by the phone, so check these details against it.
						Once approved, Ryu can use apps on this phone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{details.map(([term, value]) => (
						<div className="contents" key={term}>
							<dt className="text-muted-foreground">{term}</dt>
							<dd className="font-medium" data-term={term}>
								{value}
							</dd>
						</div>
					))}
				</dl>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							setOpen(false);
							onApprove();
						}}
					>
						Approve
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function PairedPhoneRow({
	actions,
	busy,
	canApprove,
	device,
}: {
	actions: PairedPhoneActions;
	busy: boolean;
	canApprove: boolean;
	device: PairedDevice;
}) {
	const tl = useLiteralMessages();
	const [renaming, setRenaming] = useState(false);
	const pending = device.state === "pending";
	const status = pending
		? tl("Waiting for approval")
		: device.foreground
			? tl("Open now")
			: tl("Active {when}", { when: presenceAgo(device.last_seen_ms) });
	return (
		<SettingsItem
			actions={
				renaming ? null : (
					<div className="flex items-center gap-1">
						{pending ? (
							<ApproveButton
								busy={busy}
								canApprove={canApprove}
								device={device}
								onApprove={() => actions.approve(device)}
							/>
						) : (
							<Button
								aria-label={tl("Rename {name}", { name: device.label })}
								disabled={busy}
								onClick={() => setRenaming(true)}
								size="sm"
								variant="ghost"
							>
								Rename
							</Button>
						)}
						<ForgetButton
							busy={busy}
							device={device}
							onForget={() => actions.forget(device)}
						/>
					</div>
				)
			}
			title={
				<RowTitle
					detail={`${tl(platformLabel(device.platform))} · ${status}`}
					leading={
						<SettingsIconTile
							icon={SmartPhone01Icon}
							tint={pending ? "orange" : "blue"}
						/>
					}
					name={device.label}
				/>
			}
		>
			{renaming ? (
				<RenameField
					busy={busy}
					device={device}
					onCancel={() => setRenaming(false)}
					onSave={(label) => {
						setRenaming(false);
						actions.rename(device, label);
					}}
				/>
			) : null}
			<GrantChips
				busy={busy}
				device={device}
				onRevoke={(tool) => actions.revokeGrant(device, tool)}
			/>
		</SettingsItem>
	);
}
