// Create or replace a vault policy. The policy is edited as JSON (its
// `description` and `rules`), so every rule field survives an edit; Core
// validates the rules when it saves and its refusal is shown here.

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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	putVaultPolicyDocument,
	type VaultPolicyDocument,
} from "@/src/lib/api/vault-policies.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	type PolicyFormProblem,
	parsePolicyForm,
	policyDocumentText,
} from "./vault-policy-form.ts";

function PolicyForm({
	onDone,
	policy,
	target,
	taken,
}: {
	onDone: () => void;
	policy: VaultPolicyDocument | null;
	target: ApiTarget;
	taken: readonly string[];
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [name, setName] = useState(policy?.name ?? "");
	const [text, setText] = useState(() => policyDocumentText(policy));
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const explain = (found: PolicyFormProblem): string => {
		switch (found.kind) {
			case "name":
				return tl(
					"Use 1 to 64 lowercase letters, digits, hyphens or underscores for the name."
				);
			case "exists":
				return tl(
					"A policy with this name already exists. Edit it instead, or pick another name."
				);
			case "field":
				return tl(
					"Rules do not have a {field} field. Check its spelling: the vault ignores fields it does not know.",
					{ field: found.field }
				);
			case "json":
				return tl("The policy is not valid JSON: {detail}", {
					detail: found.detail,
				});
			case "description":
				return tl('The "description" must be text.');
			case "key":
				return tl(
					'A policy has only "description" and "rules"; remove {key}.',
					{ key: found.key }
				);
			default:
				return tl(
					'The policy needs a "rules" list with at least one rule object.'
				);
		}
	};

	const submit = async () => {
		const parsed = parsePolicyForm(name, text, policy ? [] : taken);
		if (!parsed.ok) {
			setProblem(explain(parsed.problem));
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			// A new policy never replaces one: Core refuses an existing name (409),
			// even one created since the list loaded.
			const saved = await putVaultPolicyDocument(
				target,
				parsed.name,
				parsed.input,
				{ createOnly: policy === null }
			);
			await queryClient.invalidateQueries({ queryKey: ["vault", "policies"] });
			sileo.success({ title: tl("Saved policy {name}", { name: saved.name }) });
			onDone();
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not save the policy.", tl));
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
				<DialogTitle>{policy ? "Edit policy" : "New policy"}</DialogTitle>
				<DialogDescription>
					Each rule grants or denies capabilities on a path. Saving replaces the
					whole policy.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor="vault-policy-name">Name</Label>
				<Input
					aria-describedby={problem ? "vault-policy-problem" : undefined}
					aria-invalid={problem ? true : undefined}
					autoComplete="off"
					disabled={policy !== null}
					id="vault-policy-name"
					onChange={(event) => setName(event.target.value)}
					placeholder="ci-read"
					value={name}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="vault-policy-document">Policy (JSON)</Label>
				<Textarea
					aria-describedby={problem ? "vault-policy-problem" : undefined}
					aria-invalid={problem ? true : undefined}
					className="min-h-64 font-mono text-xs"
					id="vault-policy-document"
					onChange={(event) => setText(event.target.value)}
					spellCheck={false}
					value={text}
				/>
			</div>
			{problem ? (
				<p
					className="text-sm text-status-destructive"
					id="vault-policy-problem"
					role="alert"
				>
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending} type="submit">
					Save policy
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultPolicyDialog({
	onOpenChange,
	open,
	policy,
	target,
	taken = [],
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** The policy to edit, or `null` for a new one. */
	policy: VaultPolicyDocument | null;
	target: ApiTarget;
	/** Existing policy names: a new policy may not reuse one. */
	taken?: readonly string[];
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-2xl">
				{open ? (
					<PolicyForm
						onDone={() => onOpenChange(false)}
						policy={policy}
						taken={taken}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
