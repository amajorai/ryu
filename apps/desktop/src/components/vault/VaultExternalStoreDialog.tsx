// Connect an OpenBao, HashiCorp Vault or Infisical store that folders can be
// read from. Credentials live only in this dialog's state until they are
// sent; the body unmounts (dropping them) when it closes, and Core never
// returns them.

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
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { createVaultExternalStore } from "@/src/lib/api/vault-external.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import {
	AUTH_LABELS,
	emptyKvStoreForm,
	KV_AUTH_METHODS,
	KV_STORES,
	type KvAuthMethod,
	type KvStoreForm,
	type KvStoreKind,
	kvStoreInput,
} from "./vault-store-form.ts";

type TextName = Exclude<keyof KvStoreForm, "kind" | "authMethod" | "kvVersion">;

const SECRET_FIELDS = new Set<TextName>(["token", "secretId", "clientSecret"]);

function StoreForm({
	onDone,
	target,
}: {
	onDone: () => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState(() => emptyKvStoreForm());
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const update = (patch: Partial<KvStoreForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const field = (name: TextName, label: string, placeholder?: string) => (
		<div className="space-y-1.5">
			<Label htmlFor={`kv-store-${name}`}>{label}</Label>
			<Input
				autoComplete="off"
				id={`kv-store-${name}`}
				onChange={(event) => update({ [name]: event.target.value })}
				placeholder={placeholder}
				type={SECRET_FIELDS.has(name) ? "password" : "text"}
				value={form[name]}
			/>
		</div>
	);
	const infisical = form.kind === "infisical";

	const submit = async () => {
		const built = kvStoreInput(form);
		if ("problem" in built) {
			setProblem(built.problem);
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			const store = await createVaultExternalStore(target, built.input);
			await queryClient.invalidateQueries({ queryKey: ["vault", "external"] });
			sileo.success({ title: tl("Connected {name}", { name: store.name }) });
			onDone();
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not connect the store.", tl));
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
				<DialogTitle>Connect a secret store</DialogTitle>
				<DialogDescription>
					Folders can then read from it or push to it. Credentials are encrypted
					on this node and never shown again.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="kv-store-kind">Store</Label>
					<NativeSelect
						className="w-full"
						id="kv-store-kind"
						onChange={(event) =>
							setForm({
								...emptyKvStoreForm(event.target.value as KvStoreKind),
								name: form.name,
								address: form.address,
							})
						}
						value={form.kind}
					>
						{KV_STORES.map((item) => (
							<NativeSelectOption key={item.kind} value={item.kind}>
								{item.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{field("name", tl("Name"), "bao-prod")}
				{field(
					"address",
					tl("Address"),
					infisical ? "https://app.infisical.com" : "https://bao.example.com"
				)}
				<div className="space-y-1.5">
					<Label htmlFor="kv-store-auth">Sign in with</Label>
					<NativeSelect
						className="w-full"
						id="kv-store-auth"
						onChange={(event) =>
							update({ authMethod: event.target.value as KvAuthMethod })
						}
						value={form.authMethod}
					>
						{KV_AUTH_METHODS[form.kind].map((method) => (
							<NativeSelectOption key={method} value={method}>
								{AUTH_LABELS[method]}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{infisical ? (
					<>
						{field("projectId", tl("Project id"))}
						{field("infisicalEnvironment", tl("Environment"), "prod")}
						{field("secretPath", tl("Secret path (optional)"), "/")}
					</>
				) : (
					<>
						{field("mount", tl("KV mount"), "secret")}
						<div className="space-y-1.5">
							<Label htmlFor="kv-store-kvVersion">KV version</Label>
							<NativeSelect
								className="w-full"
								id="kv-store-kvVersion"
								onChange={(event) =>
									update({ kvVersion: event.target.value === "1" ? "1" : "2" })
								}
								value={form.kvVersion}
							>
								<NativeSelectOption value="2">2</NativeSelectOption>
								<NativeSelectOption value="1">1</NativeSelectOption>
							</NativeSelect>
						</div>
						{field("namespace", tl("Namespace (optional)"))}
						{form.authMethod === "token"
							? null
							: field("authMount", tl("Auth mount (optional)"))}
					</>
				)}
				{field("pathPrefix", tl("Path prefix (optional)"))}
				{form.authMethod === "token" ? field("token", tl("Token")) : null}
				{form.authMethod === "approle" ? (
					<>
						{field("roleId", tl("Role id"))}
						{field("secretId", tl("Secret id"))}
					</>
				) : null}
				{form.authMethod === "universal-auth" ? (
					<>
						{field("clientId", tl("Client id"))}
						{field("clientSecret", tl("Client secret"))}
					</>
				) : null}
				{form.authMethod === "kubernetes"
					? field("role", tl("Auth role"))
					: null}
			</div>
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

export function VaultExternalStoreDialog({
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
					<StoreForm onDone={() => onOpenChange(false)} target={target} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
