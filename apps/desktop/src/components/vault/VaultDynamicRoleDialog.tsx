// Create or replace a dynamic-secret role. Provider credentials live only in
// this dialog's state until they are sent; the body unmounts (dropping them)
// when it closes, and Core lists only a redacted summary afterwards.

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
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	putVaultDynamicRole,
	type VaultDynamicRole,
} from "@/src/lib/api/vault-dynamic.ts";
import {
	DYNAMIC_PROVIDERS,
	type DynamicProviderKind,
	type DynamicRoleForm,
	dynamicRoleInput,
	emptyDynamicRoleForm,
	RANDOM_CHARSETS,
} from "./vault-dynamic-form.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { formatTtl } from "./vault-ttl.ts";

type TextName = Exclude<keyof DynamicRoleForm, "kind" | "charset">;

const SECRET_FIELDS = new Set<TextName>([
	"connectionUrl",
	"secretAccessKey",
	"signingSecret",
]);

function initialForm(role: VaultDynamicRole | null): DynamicRoleForm {
	if (!role) {
		return emptyDynamicRoleForm();
	}
	const known = DYNAMIC_PROVIDERS.some((item) => item.kind === role.provider);
	return {
		...emptyDynamicRoleForm(
			known ? (role.provider as DynamicProviderKind) : "postgres"
		),
		name: role.name,
		defaultTtl: formatTtl(role.defaultTtlSecs),
		maxTtl: formatTtl(role.maxTtlSecs),
	};
}

function ProviderFields({
	form,
	onChange,
}: {
	form: DynamicRoleForm;
	onChange: (patch: Partial<DynamicRoleForm>) => void;
}) {
	const tl = useLiteralMessages();
	const field = (name: TextName, label: string, placeholder?: string) => (
		<div className="space-y-1.5">
			<Label htmlFor={`dynamic-role-${name}`}>{label}</Label>
			<Input
				autoComplete="off"
				id={`dynamic-role-${name}`}
				onChange={(event) => onChange({ [name]: event.target.value })}
				placeholder={placeholder}
				type={SECRET_FIELDS.has(name) ? "password" : "text"}
				value={form[name]}
			/>
		</div>
	);
	const statements = (name: TextName, label: string) => (
		<div className="space-y-1.5 sm:col-span-2">
			<Label htmlFor={`dynamic-role-${name}`}>{label}</Label>
			<Textarea
				autoComplete="off"
				className="font-mono text-xs"
				id={`dynamic-role-${name}`}
				onChange={(event) => onChange({ [name]: event.target.value })}
				rows={3}
				value={form[name]}
			/>
		</div>
	);
	switch (form.kind) {
		case "postgres":
			return (
				<>
					{field(
						"connectionUrl",
						tl("Connection URL"),
						"postgres://admin@db/app"
					)}
					{field("usernamePrefix", tl("Username prefix (optional)"), "ryu")}
					{statements(
						"creationStatements",
						tl("Creation statements, one per line")
					)}
					{statements(
						"revocationStatements",
						tl("Revocation statements (optional)")
					)}
				</>
			);
		case "aws-sts":
			return (
				<>
					{field("region", tl("Region"), "us-east-1")}
					{field(
						"roleArn",
						tl("Role ARN"),
						"arn:aws:iam::123456789012:role/ci"
					)}
					{field("accessKeyId", tl("Access key id"))}
					{field("secretAccessKey", tl("Secret access key"))}
					{field("endpoint", tl("STS endpoint (optional)"))}
					{statements("sessionPolicy", tl("Session policy JSON (optional)"))}
				</>
			);
		case "webhook":
			return (
				<>
					{field("url", tl("URL"), "https://issuer.example.com/mint")}
					{field("signingSecret", tl("Signing secret"))}
				</>
			);
		default:
			return (
				<>
					{field("length", tl("Length"), "32")}
					<div className="space-y-1.5">
						<Label htmlFor="dynamic-role-charset">Characters</Label>
						<NativeSelect
							className="w-full"
							id="dynamic-role-charset"
							onChange={(event) =>
								onChange({
									charset:
										RANDOM_CHARSETS.find(
											(item) => item === event.target.value
										) ?? "alphanumeric",
								})
							}
							value={form.charset}
						>
							{RANDOM_CHARSETS.map((item) => (
								<NativeSelectOption key={item} value={item}>
									{item}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					{field("field", tl("Returned as (optional)"), "value")}
				</>
			);
	}
}

function RoleForm({
	onDone,
	role,
	target,
}: {
	onDone: () => void;
	role: VaultDynamicRole | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState(() => initialForm(role));
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const update = (patch: Partial<DynamicRoleForm>) =>
		setForm((current) => ({ ...current, ...patch }));

	const submit = async () => {
		const built = dynamicRoleInput(form);
		if ("problem" in built) {
			setProblem(built.problem);
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			const saved = await putVaultDynamicRole(target, built.name, built.input);
			await queryClient.invalidateQueries({ queryKey: ["vault", "dynamic"] });
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
				<DialogTitle>{role ? "Replace role" : "New dynamic role"}</DialogTitle>
				<DialogDescription>
					Provider credentials are sealed on this node and never shown again.
					Replacing a role needs them again, and a role with live leases keeps
					its provider until they are revoked.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="dynamic-role-name">Name</Label>
					<Input
						autoComplete="off"
						disabled={role !== null}
						id="dynamic-role-name"
						onChange={(event) => update({ name: event.target.value })}
						placeholder="db-readonly"
						value={form.name}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="dynamic-role-kind">Provider</Label>
					<NativeSelect
						className="w-full"
						id="dynamic-role-kind"
						onChange={(event) =>
							setForm({
								...emptyDynamicRoleForm(
									event.target.value as DynamicProviderKind
								),
								name: form.name,
								defaultTtl: form.defaultTtl,
								maxTtl: form.maxTtl,
							})
						}
						value={form.kind}
					>
						{DYNAMIC_PROVIDERS.map((item) => (
							<NativeSelectOption key={item.kind} value={item.kind}>
								{item.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="dynamic-role-defaultTtl">Default TTL</Label>
					<Input
						autoComplete="off"
						id="dynamic-role-defaultTtl"
						onChange={(event) => update({ defaultTtl: event.target.value })}
						placeholder="1h"
						value={form.defaultTtl}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="dynamic-role-maxTtl">Maximum TTL</Label>
					<Input
						autoComplete="off"
						id="dynamic-role-maxTtl"
						onChange={(event) => update({ maxTtl: event.target.value })}
						placeholder="24h"
						value={form.maxTtl}
					/>
				</div>
				<ProviderFields form={form} onChange={update} />
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

export function VaultDynamicRoleDialog({
	onOpenChange,
	open,
	role,
	target,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** The role to replace, or `null` for a new one. */
	role: VaultDynamicRole | null;
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
