// Create an AppRole machine identity. Core generates its role id; secret ids
// and tokens are issued from the identity's credentials afterwards, so this
// form never handles a secret.

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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createVaultAppRole,
	type VaultMachine,
} from "@/src/lib/api/vault-machines.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { type AppRoleForm, appRoleInput } from "./vault-machine-form.ts";

function AppRoleBody({
	onCreated,
	onCancel,
	target,
}: {
	onCancel: () => void;
	onCreated: (machine: VaultMachine) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState<AppRoleForm>({
		name: "",
		policies: "",
		ttl: "",
	});
	const [problem, setProblem] = useState<string | null>(null);
	const create = useMutation({
		mutationFn: (input: Parameters<typeof createVaultAppRole>[1]) =>
			createVaultAppRole(target, input),
		onSuccess: async (machine) => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "machines"],
			});
			onCreated(machine);
		},
		onError: (error) =>
			setProblem(vaultErrorMessage(error, "Could not create the AppRole.", tl)),
	});
	const field = (key: keyof AppRoleForm) => (value: string) =>
		setForm((current) => ({ ...current, [key]: value }));

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				const parsed = appRoleInput(form);
				if ("problem" in parsed) {
					setProblem(parsed.problem);
					return;
				}
				setProblem(null);
				create.mutate(parsed.input);
			}}
		>
			<DialogHeader>
				<DialogTitle>New AppRole</DialogTitle>
				<DialogDescription>
					A machine that logs in with a role ID and a secret ID. Issue secret
					IDs once it exists.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor="approle-name">Name</Label>
				<Input
					aria-describedby={problem ? "approle-problem" : undefined}
					aria-invalid={problem ? true : undefined}
					autoComplete="off"
					id="approle-name"
					onChange={(event) => field("name")(event.target.value)}
					value={form.name}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="approle-policies">Policies</Label>
				<Input
					aria-describedby={problem ? "approle-problem" : undefined}
					aria-invalid={problem ? true : undefined}
					id="approle-policies"
					onChange={(event) => field("policies")(event.target.value)}
					placeholder={tl("Comma-separated policy names")}
					value={form.policies}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="approle-ttl">Token lifetime</Label>
				<Input
					aria-describedby={problem ? "approle-problem" : undefined}
					aria-invalid={problem ? true : undefined}
					id="approle-ttl"
					onChange={(event) => field("ttl")(event.target.value)}
					placeholder={tl("Default")}
					value={form.ttl}
				/>
			</div>
			{problem ? (
				<p
					className="text-sm text-status-destructive"
					id="approle-problem"
					role="alert"
				>
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button onClick={onCancel} type="button" variant="ghost">
					Cancel
				</Button>
				<Button disabled={create.isPending} type="submit">
					Create AppRole
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultAppRoleDialog({
	onCreated,
	onOpenChange,
	open,
	target,
}: {
	onCreated: (machine: VaultMachine) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? (
					<AppRoleBody
						onCancel={() => onOpenChange(false)}
						onCreated={onCreated}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
