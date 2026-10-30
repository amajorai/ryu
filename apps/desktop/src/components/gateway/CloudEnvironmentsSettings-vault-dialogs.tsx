import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useState } from "react";
import {
	type CloudEnvironment,
	type CloudVaultEntry,
	type CloudVaultEntryWrite,
	type CloudVaultKind,
	parseEnvironmentPaste,
} from "@/src/lib/api/cloud-environments.ts";
import { errorMessage, lines } from "./CloudEnvironmentsSettings-shared.ts";

export function VaultDialog({
	initial,
	initialKind = "variable",
	initialEnvironmentIds = [],
	saveDescription,
	error: saveError,
	environments,
	busy,
	onClose,
	onSave,
}: {
	initial: CloudVaultEntry | null;
	initialKind?: CloudVaultKind;
	initialEnvironmentIds?: string[];
	saveDescription?: string;
	error: string | null;
	environments: CloudEnvironment[];
	busy: boolean;
	onClose: () => void;
	onSave: (entries: CloudVaultEntryWrite[]) => Promise<void>;
}) {
	const [key, setKey] = useState(initial?.key ?? "");
	const [value, setValue] = useState("");
	const [kind, setKind] = useState<CloudVaultKind>(
		initial?.kind ?? initialKind
	);
	const [scope, setScope] = useState(
		initial?.environmentIds ?? initialEnvironmentIds
	);
	const [domains, setDomains] = useState(initial?.domains.join(", ") ?? "");
	const [paste, setPaste] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		setError(null);
		try {
			if (initial && kind !== initial.kind && !value && !paste) {
				throw new Error(
					"Enter a replacement value when changing the entry type"
				);
			}
			const pairs = parseEnvironmentPaste(paste || `${key}=${value}`);
			if (!pairs.length) {
				throw new Error("Enter a key and value");
			}
			await onSave(
				pairs.map((pair) => ({
					id: initial?.key === pair.key ? initial.id : crypto.randomUUID(),
					key: pair.key,
					...(initial && !value && !paste ? undefined : { value: pair.value }),
					kind,
					environmentIds: scope,
					domains: lines(domains),
					hasValue: true,
				}))
			);
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};

	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{initial ? "Edit personal vault entry" : "Add to personal vault"}
					</DialogTitle>
					<DialogDescription>
						{saveDescription ??
							"Only your tasks can use these values where an environment requests their keys. Saved values stay hidden."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<KindSelect kind={kind} onChange={setKind} />
					<div className="space-y-2">
						<Label htmlFor="vault-key">Key</Label>
						<Input
							disabled={initial !== null}
							id="vault-key"
							onChange={(event) => setKey(event.target.value)}
							value={key}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="vault-value">Value</Label>
						<Input
							autoComplete="off"
							id="vault-value"
							onChange={(event) => setValue(event.target.value)}
							placeholder={
								initial ? "Leave blank to keep saved value" : undefined
							}
							type="password"
							value={value}
						/>
					</div>
					<VaultEnvironmentScope
						environments={environments}
						onChange={setScope}
						value={scope}
					/>
					{kind === "networkSecret" ? (
						<div className="space-y-2">
							<Label htmlFor="vault-domains">Allowed domains</Label>
							<Input
								id="vault-domains"
								onChange={(event) => setDomains(event.target.value)}
								placeholder="api.example.com"
								value={domains}
							/>
						</div>
					) : null}
					<details>
						<summary className="cursor-pointer text-sm">
							Paste .env entries
						</summary>
						<Textarea
							aria-label="Paste .env entries"
							className="mt-2 [-webkit-text-security:disc]"
							onChange={(event) => setPaste(event.target.value)}
							placeholder="KEY=value"
							typography="caption"
							value={paste}
							variant="code"
						/>
					</details>
					{error || saveError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error ?? saveError}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={busy || !(key.trim() || paste.trim())}
						onClick={submit}
						variant="outline"
					>
						{busy ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function VpnDialog({
	hasSavedKey,
	busy,
	onClose,
	onSave,
}: {
	hasSavedKey: boolean;
	busy: boolean;
	onClose: () => void;
	onSave: (value: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Tailscale VPN</DialogTitle>
					<DialogDescription>
						Use an ephemeral, tagged, short-expiry Tailscale auth key. Saving
						does not test the connection. The key is saved with the environment
						and stays hidden after saving.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="cloud-vpn-auth-key">Tailscale auth key</Label>
					<Input
						autoComplete="off"
						id="cloud-vpn-auth-key"
						onChange={(event) => setValue(event.target.value)}
						placeholder={hasSavedKey ? "Enter a replacement key" : undefined}
						type="password"
						value={value}
					/>
					<p className="text-muted-foreground text-xs">
						For restricted internet policies, add private IPv4 addresses or
						ordinary DNS hostnames that resolve to IPv4 under Additional allowed
						domains. Tailscale MagicDNS and IPv6 are not supported.
					</p>
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={busy || !value.trim()}
						onClick={() => onSave(value.trim())}
						variant="outline"
					>
						Save VPN key
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function VaultEnvironmentScope({
	environments,
	value,
	onChange,
}: {
	environments: CloudEnvironment[];
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return (
		<fieldset className="space-y-2">
			<legend className="font-medium text-sm">Applies to</legend>
			<Label>
				<Checkbox
					checked={value.length === 0}
					onCheckedChange={(checked) =>
						onChange(checked ? [] : environments[0] ? [environments[0].id] : [])
					}
				/>
				All environments
			</Label>
			<div className="max-h-36 space-y-2 overflow-y-auto">
				{environments.map((environment) => (
					<Label key={environment.id}>
						<Checkbox
							checked={value.includes(environment.id)}
							onCheckedChange={(checked) =>
								onChange(
									checked
										? [...value, environment.id]
										: value.length === 1
											? value
											: value.filter((id) => id !== environment.id)
								)
							}
						/>
						{environment.name}
					</Label>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				Select one or more environments, or choose All environments.
			</p>
		</fieldset>
	);
}

export function KindSelect({
	kind,
	onChange,
}: {
	kind: CloudVaultKind;
	onChange: (value: CloudVaultKind) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="vault-kind">Type</Label>
			<NativeSelect
				id="vault-kind"
				onChange={(event) =>
					onChange(
						event.target.value === "networkSecret"
							? "networkSecret"
							: "variable"
					)
				}
				value={kind}
			>
				<NativeSelectOption value="variable">
					Environment variable
				</NativeSelectOption>
				<NativeSelectOption value="networkSecret">
					Network secret
				</NativeSelectOption>
			</NativeSelect>
			<p className="text-muted-foreground text-xs">
				{kind === "variable"
					? "Real value inside the environment, visible to tasks and tools."
					: "Hidden value, replaced in outgoing requests by a supported proxy."}
			</p>
		</div>
	);
}
