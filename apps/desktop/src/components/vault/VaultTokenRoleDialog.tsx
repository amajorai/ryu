// Create or replace a token role. Saving sends the whole role, so a field
// left blank is cleared on the role.

import { useLiteralMessages } from "@ryu/i18n/react";
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
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	putVaultTokenRole,
	type VaultTokenRole,
} from "@/src/lib/api/vault-token-roles.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	type TokenRoleForm,
	tokenRoleForm,
	tokenRoleInput,
} from "./vault-token-role-form.ts";

type TextName = Exclude<keyof TokenRoleForm, "orphan" | "renewable">;

function RoleForm({
	onDone,
	role,
	target,
}: {
	onDone: () => void;
	role: VaultTokenRole | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState(() => tokenRoleForm(role));
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const update = (patch: Partial<TokenRoleForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const field = (
		name: TextName,
		label: string,
		placeholder?: string,
		wide = false
	) => (
		<div className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
			<Label htmlFor={`token-role-${name}`}>{label}</Label>
			<Input
				autoComplete="off"
				disabled={name === "name" && role !== null}
				id={`token-role-${name}`}
				onChange={(event) => update({ [name]: event.target.value })}
				placeholder={placeholder}
				value={form[name]}
			/>
		</div>
	);
	const toggle = (name: "orphan" | "renewable", label: string) => (
		<div className="flex items-center gap-2">
			<Checkbox
				checked={form[name]}
				id={`token-role-${name}`}
				onCheckedChange={(on: boolean) => update({ [name]: on })}
			/>
			<Label className="font-normal" htmlFor={`token-role-${name}`}>
				{label}
			</Label>
		</div>
	);

	const submit = async () => {
		const built = tokenRoleInput(form);
		if ("problem" in built) {
			setProblem(built.problem);
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			const saved = await putVaultTokenRole(target, built.name, built.input);
			await queryClient.invalidateQueries({
				queryKey: ["vault", "token-roles"],
			});
			sileo.success({ title: tl("Saved role {name}", { name: saved.name }) });
			onDone();
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not save the role.", tl));
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
				<DialogTitle>{role ? "Edit token role" : "New token role"}</DialogTitle>
				<DialogDescription>
					Tokens minted with this role get these limits. Durations look like
					90s, 15m, 1h or 7d; leave a field blank for the default.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				{field("name", tl("Name"), "ci-deploy", true)}
				{field(
					"allowedPolicies",
					tl("Allowed policies"),
					"ci-read, ci-write",
					true
				)}
				{field("disallowedPolicies", tl("Disallowed policies"), "root", true)}
				{field("ttl", tl("TTL"), "1h")}
				{field("maxTtl", tl("Maximum TTL"), "24h")}
				{field("explicitMaxTtl", tl("Hard maximum TTL"))}
				{field("period", tl("Renewal period"))}
				{field("numUses", tl("Uses (0 for unlimited)"))}
				{field("boundCidrs", tl("Bound CIDRs"), "10.0.0.0/8")}
				{toggle("renewable", tl("Tokens can be renewed"))}
				{toggle("orphan", tl("Tokens have no parent"))}
			</div>
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending} type="submit">
					Save role
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultTokenRoleDialog({
	onOpenChange,
	open,
	role,
	target,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** The role to edit, or `null` for a new one. */
	role: VaultTokenRole | null;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? (
					<RoleForm
						onDone={() => onOpenChange(false)}
						role={role}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
