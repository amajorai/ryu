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
import { useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudEnvironment,
	type CloudVaultKind,
	fetchImportVariableNames,
	isLocalCloudVariableImport,
} from "@/src/lib/api/cloud-environments.ts";
import { errorMessage } from "./CloudEnvironmentsSettings-shared.ts";
import { KindSelect } from "./CloudEnvironmentsSettings-vault-dialogs.tsx";

function EnvironmentScope({
	environments,
	value,
	onChange,
}: {
	environments: CloudEnvironment[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="vault-scope">Applies to</Label>
			<NativeSelect
				id="vault-scope"
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				<NativeSelectOption value="">All environments</NativeSelectOption>
				{environments.map((item) => (
					<NativeSelectOption key={item.id} value={item.id}>
						{item.name}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}

export function ImportDialog({
	saveError,
	target,
	environments,
	busy,
	onClose,
	onImport,
}: {
	saveError: string | null;
	target: ApiTarget;
	environments: CloudEnvironment[];
	busy: boolean;
	onClose: () => void;
	onImport: (
		keys: string[],
		kind: CloudVaultKind,
		environmentIds: string[]
	) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [names, setNames] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [search, setSearch] = useState("");
	const [kind, setKind] = useState<CloudVaultKind>("variable");
	const [scope, setScope] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		fetchImportVariableNames({
			url: target.url,
			token: target.token,
			userJwt: target.userJwt,
		})
			.then((values) => {
				if (active) {
					setNames(values);
				}
			})
			.catch((failure) => {
				if (active) {
					setError(errorMessage(failure));
				}
			});
		return () => {
			active = false;
		};
	}, [target.url, target.token, target.userJwt]);

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
						{isLocalCloudVariableImport()
							? "Import local variables"
							: "Import node variables"}
					</DialogTitle>
					<DialogDescription>
						{isLocalCloudVariableImport()
							? tl(
									"Choose up to 100 variables from this computer's shell environment."
								)
							: tl(
									"Choose up to 100 variables from the selected node's process environment. Node owner access is required."
								)}{" "}
						{tl(
							"Reserved variables are excluded. Values stay hidden and only selected values are saved."
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<KindSelect kind={kind} onChange={setKind} />
					<Input
						aria-label="Search variable names"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search variable names"
						value={search}
					/>
					<div className="max-h-60 space-y-3 overflow-y-auto">
						{names ? (
							names
								.filter((name) =>
									name.toLowerCase().includes(search.toLowerCase())
								)
								.map((name) => (
									<Label
										className="justify-between"
										key={name}
										spacing="field-row"
									>
										<span className="break-all font-mono text-xs">{name}</span>
										<Checkbox
											checked={selected.includes(name)}
											disabled={
												!selected.includes(name) && selected.length >= 100
											}
											onCheckedChange={(checked) =>
												setSelected((current) =>
													checked
														? [...current, name]
														: current.filter((item) => item !== name)
												)
											}
										/>
									</Label>
								))
						) : error ? null : (
							<p role="status">Loading variable names…</p>
						)}
					</div>
					<p className="text-muted-foreground text-xs">
						{tl("{count} variables selected", { count: selected.length })}
					</p>
					<EnvironmentScope
						environments={environments}
						onChange={setScope}
						value={scope}
					/>
					{error || saveError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error ?? saveError}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Close
					</Button>
					<Button
						disabled={busy || !selected.length}
						onClick={() => onImport(selected, kind, scope ? [scope] : [])}
						variant="outline"
					>
						{busy ? "Importing…" : "Import selected"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
