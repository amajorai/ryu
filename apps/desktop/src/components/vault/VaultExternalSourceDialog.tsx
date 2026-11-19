// Read a folder from a connected OpenBao, HashiCorp Vault or Infisical store.
// `sync` copies the remote keys into the folder on a schedule; `live` reads
// them through on use with a short cache. Values are changed in the store.

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
import {
	createVaultExternalSource,
	type VaultExternalStore,
} from "@/src/lib/api/vault-external.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { type SourceForm, sourceInput } from "./vault-store-form.ts";

function Body({
	environment,
	onDone,
	stores,
	target,
}: {
	environment: string;
	onDone: () => void;
	stores: VaultExternalStore[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [form, setForm] = useState<SourceForm>(() => ({
		interval: "5m",
		mode: "sync",
		path: "",
		remotePath: "",
		storeId: stores[0]?.id ?? "",
	}));
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const update = (patch: Partial<SourceForm>) =>
		setForm((current) => ({ ...current, ...patch }));

	const submit = async () => {
		const built = sourceInput(form, environment);
		if ("problem" in built) {
			setProblem(built.problem);
			return;
		}
		setPending(true);
		setProblem(null);
		try {
			const source = await createVaultExternalSource(target, built.input);
			await queryClient.invalidateQueries({ queryKey: ["vault", "external"] });
			sileo.success({
				title: tl("{folder} now reads from the store", {
					folder: `${source.environment}:${source.path}`,
				}),
			});
			onDone();
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not add the source.", tl));
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
				<DialogTitle>Read a folder from a store</DialogTitle>
				<DialogDescription>
					{tl(
						"The folder in {environment} is filled from the store. Change its values in the store.",
						{ environment }
					)}
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="source-store">Store</Label>
					<NativeSelect
						className="w-full"
						id="source-store"
						onChange={(event) => update({ storeId: event.target.value })}
						value={form.storeId}
					>
						{stores.map((store) => (
							<NativeSelectOption key={store.id} value={store.id}>
								{store.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="source-mode">Mode</Label>
					<NativeSelect
						className="w-full"
						id="source-mode"
						onChange={(event) =>
							update({ mode: event.target.value === "live" ? "live" : "sync" })
						}
						value={form.mode}
					>
						<NativeSelectOption value="sync">
							Copy on a schedule
						</NativeSelectOption>
						<NativeSelectOption value="live">Read on use</NativeSelectOption>
					</NativeSelect>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="source-path">Folder</Label>
					<Input
						autoComplete="off"
						id="source-path"
						onChange={(event) => update({ path: event.target.value })}
						placeholder="/bao/web"
						value={form.path}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="source-remote">Remote path</Label>
					<Input
						autoComplete="off"
						id="source-remote"
						onChange={(event) => update({ remotePath: event.target.value })}
						placeholder="apps/web"
						value={form.remotePath}
					/>
				</div>
				{form.mode === "sync" ? (
					<div className="space-y-1.5">
						<Label htmlFor="source-interval">Every</Label>
						<Input
							autoComplete="off"
							id="source-interval"
							onChange={(event) => update({ interval: event.target.value })}
							placeholder="5m"
							value={form.interval}
						/>
					</div>
				) : null}
			</div>
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending || stores.length === 0} type="submit">
					Add source
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultExternalSourceDialog({
	environment,
	onOpenChange,
	open,
	stores,
	target,
}: {
	environment: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** Stores folders can read from (not push-only sync targets). */
	stores: VaultExternalStore[];
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? (
					<Body
						environment={environment}
						onDone={() => onOpenChange(false)}
						stores={stores}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
