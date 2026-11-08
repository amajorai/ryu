// Connect a secret-sync target. Credentials live only in this dialog's state
// until they are sent; the body unmounts (dropping them) when it closes, and
// Core never returns them.

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
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { createVaultExternalStore } from "@/src/lib/api/vault-external.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	emptySyncTargetForm,
	SYNC_TARGETS,
	type SyncTargetForm,
	type SyncTargetKind,
	syncTargetInput,
	VERCEL_TARGETS,
} from "./vault-sync-form.ts";

type Field = Exclude<
	keyof SyncTargetForm,
	"kind" | "gcpAuth" | "vercelTargets"
>;

function TextField({
	form,
	id,
	label,
	name,
	onChange,
	placeholder,
	secret = false,
}: {
	form: SyncTargetForm;
	id: string;
	label: string;
	name: Field;
	onChange: (patch: Partial<SyncTargetForm>) => void;
	placeholder?: string;
	secret?: boolean;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				autoComplete="off"
				id={id}
				onChange={(event) => onChange({ [name]: event.target.value })}
				placeholder={placeholder}
				type={secret ? "password" : "text"}
				value={form[name]}
			/>
		</div>
	);
}

function KindFields({
	form,
	onChange,
}: {
	form: SyncTargetForm;
	onChange: (patch: Partial<SyncTargetForm>) => void;
}) {
	const field = (name: Field, label: string, placeholder?: string) => (
		<TextField
			form={form}
			id={`sync-target-${name}`}
			label={label}
			name={name}
			onChange={onChange}
			placeholder={placeholder}
			secret={
				name === "token" ||
				name === "secretAccessKey" ||
				name === "sessionToken"
			}
		/>
	);
	switch (form.kind) {
		case "github-actions":
			return (
				<>
					{field("repository", "Repository", "owner/repo")}
					{field("githubEnvironment", "Environment (optional)", "production")}
					{field("token", "Token")}
				</>
			);
		case "vercel":
			return (
				<>
					{field("projectId", "Project", "prj_…")}
					{field("teamId", "Team id (optional)", "team_…")}
					<fieldset className="space-y-1.5">
						<legend className="mb-1 font-medium text-sm">Environments</legend>
						{VERCEL_TARGETS.map((name) => (
							<div className="flex items-center gap-2" key={name}>
								<Checkbox
									checked={form.vercelTargets.includes(name)}
									id={`sync-target-vercel-${name}`}
									onCheckedChange={(on: boolean) =>
										onChange({
											vercelTargets: on
												? [...form.vercelTargets, name]
												: form.vercelTargets.filter((item) => item !== name),
										})
									}
								/>
								<Label
									className="font-normal"
									htmlFor={`sync-target-vercel-${name}`}
								>
									{name}
								</Label>
							</div>
						))}
					</fieldset>
					{field("token", "Token")}
				</>
			);
		case "aws-secrets-manager":
			return (
				<>
					{field("region", "Region", "us-east-1")}
					{field("pathPrefix", "Secret name prefix (optional)", "ryu")}
					{field("accessKeyId", "Access key id")}
					{field("secretAccessKey", "Secret access key")}
					{field("sessionToken", "Session token (optional)")}
				</>
			);
		default:
			return (
				<>
					{field("projectId", "Project id", "my-project")}
					<div className="space-y-1.5">
						<Label htmlFor="sync-target-gcp-auth">Sign in with</Label>
						<NativeSelect
							className="w-full"
							id="sync-target-gcp-auth"
							onChange={(event) =>
								onChange({
									gcpAuth:
										event.target.value === "token"
											? "token"
											: "service-account",
								})
							}
							value={form.gcpAuth}
						>
							<NativeSelectOption value="service-account">
								Service-account key
							</NativeSelectOption>
							<NativeSelectOption value="token">
								Access token
							</NativeSelectOption>
						</NativeSelect>
					</div>
					{form.gcpAuth === "token" ? (
						field("token", "Access token")
					) : (
						<div className="space-y-1.5">
							<Label htmlFor="sync-target-key">
								Service-account key (JSON)
							</Label>
							<Textarea
								autoComplete="off"
								className="font-mono text-xs"
								id="sync-target-key"
								onChange={(event) =>
									onChange({ serviceAccountKey: event.target.value })
								}
								rows={4}
								value={form.serviceAccountKey}
							/>
						</div>
					)}
				</>
			);
	}
}

function TargetForm({
	onDone,
	target,
}: {
	onDone: () => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState(emptySyncTargetForm);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const update = (patch: Partial<SyncTargetForm>) =>
		setForm((current) => ({ ...current, ...patch }));

	const submit = async () => {
		const built = syncTargetInput(form);
		if ("problem" in built) {
			setProblem(built.problem);
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			const store = await createVaultExternalStore(target, built.input);
			await queryClient.invalidateQueries({
				queryKey: ["vault", "external"],
			});
			sileo.success({ title: tl("Connected {name}", { name: store.name }) });
			onDone();
		} catch (caught) {
			setProblem(
				vaultErrorMessage(caught, "Could not connect the target.", tl)
			);
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
				<DialogTitle>Connect a sync target</DialogTitle>
				<DialogDescription>
					Credentials are encrypted on this node and never shown again.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="sync-target-kind">Platform</Label>
					<NativeSelect
						className="w-full"
						id="sync-target-kind"
						onChange={(event) =>
							setForm({
								...emptySyncTargetForm(event.target.value as SyncTargetKind),
								name: form.name,
							})
						}
						value={form.kind}
					>
						{SYNC_TARGETS.map((item) => (
							<NativeSelectOption key={item.kind} value={item.kind}>
								{item.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<TextField
					form={form}
					id="sync-target-name"
					label="Name"
					name="name"
					onChange={update}
					placeholder="acme-ci"
				/>
			</div>
			<KindFields form={form} onChange={update} />
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending} type="submit">
					Connect
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultSyncTargetDialog({
	onOpenChange,
	open,
	target,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? (
					<TargetForm onDone={() => onOpenChange(false)} target={target} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
