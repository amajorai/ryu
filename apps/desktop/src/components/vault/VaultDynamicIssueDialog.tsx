// Issue a dynamic credential from a role. The credential is shown once: it
// lives only in this dialog's state (not a React Query cache) and is dropped
// when the dialog closes. Core keeps the lease, never the credential.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
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
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	issueVaultDynamicCredential,
	type VaultDynamicCredential,
	type VaultDynamicRole,
} from "@/src/lib/api/vault-dynamic.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { copyWithToast } from "./vault-copy.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { formatTtl, parseTtl, timestampMillis } from "./vault-ttl.ts";

function Issued({ credential }: { credential: VaultDynamicCredential }) {
	const tl = useLiteralMessages();
	const copy = (text: string) => copyWithToast(text, tl);
	const expires = timestampMillis(credential.lease.expiresAt);
	return (
		<>
			<DialogHeader>
				<DialogTitle>Credential issued</DialogTitle>
				<DialogDescription>
					Copy it now. It is not shown again; revoke the lease to retire it
					early.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-3">
				{Object.entries(credential.data).map(([field, value]) => (
					<div className="space-y-1.5" key={field}>
						<Label htmlFor={`dynamic-issued-${field}`}>{field}</Label>
						<div className="flex gap-2">
							<Input
								className="font-mono"
								id={`dynamic-issued-${field}`}
								readOnly
								value={value}
							/>
							<Button
								aria-label={tl("Copy {field}", { field })}
								onClick={() => copy(value)}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Copy01Icon} />
							</Button>
						</div>
					</div>
				))}
			</div>
			<p className="text-detail text-muted-foreground">
				{tl("Lease {lease} expires {expires}.", {
					lease: credential.lease.id,
					expires: expires === null ? "" : formatDateTime(expires),
				})}
			</p>
		</>
	);
}

function IssueForm({
	onIssued,
	role,
	target,
}: {
	onIssued: (credential: VaultDynamicCredential) => void;
	role: VaultDynamicRole;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [ttl, setTtl] = useState(() => formatTtl(role.defaultTtlSecs));
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// Not a React Query mutation: its cache would keep the credential.
	const submit = async () => {
		const ttlSecs = parseTtl(ttl);
		if (ttlSecs === null) {
			setProblem(tl("Durations look like 90s, 15m, 1h or 7d."));
			return;
		}
		setProblem(null);
		setPending(true);
		try {
			const credential = await issueVaultDynamicCredential(
				target,
				role.name,
				ttlSecs
			);
			await queryClient.invalidateQueries({
				queryKey: ["vault", "dynamic", "leases"],
			});
			onIssued(credential);
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not issue.", tl));
		} finally {
			setPending(false);
		}
	};

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<DialogHeader>
				<DialogTitle>
					{tl("Issue from {role}", { role: role.name })}
				</DialogTitle>
				<DialogDescription>
					{tl(
						"Creates a credential with a lease. The maximum lifetime is {max}.",
						{ max: formatTtl(role.maxTtlSecs) }
					)}
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor="dynamic-issue-ttl">TTL</Label>
				<Input
					autoComplete="off"
					id="dynamic-issue-ttl"
					onChange={(event) => setTtl(event.target.value)}
					placeholder={formatTtl(role.defaultTtlSecs)}
					value={ttl}
				/>
			</div>
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending} loading={pending} type="submit">
					Issue
				</Button>
			</DialogFooter>
		</form>
	);
}

function IssueBody({
	role,
	target,
}: {
	role: VaultDynamicRole;
	target: ApiTarget;
}) {
	const [credential, setCredential] = useState<VaultDynamicCredential | null>(
		null
	);
	return credential ? (
		<Issued credential={credential} />
	) : (
		<IssueForm onIssued={setCredential} role={role} target={target} />
	);
}

export function VaultDynamicIssueDialog({
	onOpenChange,
	role,
	target,
}: {
	onOpenChange: (open: boolean) => void;
	/** The role to issue from; `null` closes the dialog. */
	role: VaultDynamicRole | null;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={role !== null}>
			<DialogContent className="sm:max-w-lg">
				{role ? (
					<IssueBody key={role.name} role={role} target={target} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
