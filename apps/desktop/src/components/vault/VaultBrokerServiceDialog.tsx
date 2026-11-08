// Create or edit one broker service. A new service starts from a catalog
// template (host, path and auth scheme filled in; only the credential
// reference and name are asked for) or from a blank form, optionally seeded
// from a discovered host. Credential fields take references such as
// `secret:NAME`, never values, so nothing here is sensitive.

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
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createVaultBrokerService,
	listVaultBrokerCatalog,
	updateVaultBrokerService,
	type VaultBrokerService,
	type VaultBrokerTemplateInput,
} from "@/src/lib/api/vault-broker.ts";
import { BrokerAuthFields } from "./VaultBrokerAuthFields.tsx";
import {
	type BrokerServiceForm,
	emptyServiceForm,
	serviceFormFrom,
	serviceInputFrom,
} from "./vault-broker-service-form.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export type BrokerServiceDraft =
	| {
			environment: string;
			mode: "create";
			seed?: BrokerServiceForm;
			template?: string;
	  }
	| { mode: "edit"; service: VaultBrokerService };

const CUSTOM = "";

function TextField({
	disabled,
	id,
	label,
	onChange,
	placeholder,
	value,
}: {
	disabled?: boolean;
	id: string;
	label: string;
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				autoComplete="off"
				disabled={disabled}
				id={id}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				spellCheck={false}
				value={value}
			/>
		</div>
	);
}

function ServiceForm({
	draft,
	onDone,
	target,
}: {
	draft: BrokerServiceDraft;
	onDone: () => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const editing = draft.mode === "edit" ? draft.service : undefined;
	const [form, setForm] = useState<BrokerServiceForm>(() => {
		if (draft.mode === "edit") {
			return serviceFormFrom(draft.service);
		}
		return draft.seed ?? emptyServiceForm(draft.environment);
	});
	const [template, setTemplate] = useState(
		draft.mode === "create" ? (draft.template ?? CUSTOM) : CUSTOM
	);
	const [credentialRef, setCredentialRef] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const catalogQuery = useQuery({
		enabled: draft.mode === "create",
		queryKey: ["vault", "broker", "catalog", target.url],
		queryFn: () => listVaultBrokerCatalog(target),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const templates = catalogQuery.data ?? [];
	const chosen = templates.find((item) => item.id === template);
	const set = (patch: Partial<BrokerServiceForm>) =>
		setForm((current) => ({ ...current, ...patch }));

	const saveMutation = useMutation({
		mutationFn: () => {
			if (chosen) {
				const body: VaultBrokerTemplateInput = {
					environment: form.environment,
					template: chosen.id,
				};
				const name = form.name.trim();
				const reference = credentialRef.trim();
				if (name) {
					body.name = name;
				}
				if (reference && reference !== chosen.suggestedRef) {
					body.credentialRef = reference;
				}
				return createVaultBrokerService(target, body);
			}
			const built = serviceInputFrom(form, editing);
			if ("error" in built) {
				throw new Error(built.error);
			}
			return editing
				? updateVaultBrokerService(target, editing.name, built.input)
				: createVaultBrokerService(target, built.input);
		},
		onSuccess: async (service) => {
			await queryClient.invalidateQueries({ queryKey: ["vault", "broker"] });
			sileo.success({
				title: editing ? "Service saved" : "Service added",
				description: service.name,
			});
			onDone();
		},
		onError: (error) => {
			setProblem(vaultErrorMessage(error, "Could not save the service.", tl));
		},
	});

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				setProblem(null);
				saveMutation.mutate();
			}}
		>
			<DialogHeader>
				<DialogTitle>{editing ? "Edit service" : "Add service"}</DialogTitle>
				<DialogDescription>
					{tl(
						"Agents in {environment} reach this host through the broker, which adds the credential.",
						{ environment: form.environment }
					)}
				</DialogDescription>
			</DialogHeader>
			{editing ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="broker-service-template">Start from</Label>
					<NativeSelect
						className="w-full"
						disabled={catalogQuery.isLoading}
						id="broker-service-template"
						onChange={(event) => {
							const next = templates.find(
								(item) => item.id === event.target.value
							);
							setTemplate(next?.id ?? CUSTOM);
							setCredentialRef(next?.suggestedRef ?? "");
						}}
						value={chosen ? chosen.id : CUSTOM}
					>
						<NativeSelectOption value={CUSTOM}>
							Custom service
						</NativeSelectOption>
						{templates.map((item) => (
							<NativeSelectOption key={item.id} value={item.id}>
								{`${item.name} (${item.host})`}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			)}
			<TextField
				disabled={Boolean(editing)}
				id="broker-service-name"
				label="Name"
				onChange={(name) => set({ name })}
				placeholder={chosen?.id ?? "stripe"}
				value={form.name}
			/>
			{chosen ? (
				<TextField
					id="broker-service-credential"
					label="Credential reference"
					onChange={setCredentialRef}
					placeholder={chosen.suggestedRef}
					value={credentialRef}
				/>
			) : (
				<>
					<div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
						<TextField
							id="broker-service-host"
							label="Host"
							onChange={(host) => set({ host })}
							placeholder="api.example.com"
							value={form.host}
						/>
						<TextField
							id="broker-service-port"
							label="Port"
							onChange={(port) => set({ port })}
							placeholder="443"
							value={form.port}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<TextField
							id="broker-service-path"
							label="Path prefix"
							onChange={(pathPrefix) => set({ pathPrefix })}
							value={form.pathPrefix}
						/>
						<TextField
							id="broker-service-description"
							label="Description"
							onChange={(description) => set({ description })}
							value={form.description}
						/>
					</div>
					<BrokerAuthFields form={form} onChange={set} />
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor="broker-service-enabled">Enabled</Label>
						<Switch
							checked={form.enabled}
							id="broker-service-enabled"
							onCheckedChange={(enabled: boolean) => set({ enabled })}
						/>
					</div>
				</>
			)}
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={saveMutation.isPending} type="submit">
					{editing ? "Save" : "Add service"}
				</Button>
			</DialogFooter>
		</form>
	);
}

export function VaultBrokerServiceDialog({
	draft,
	onOpenChange,
	target,
}: {
	draft: BrokerServiceDraft | null;
	onOpenChange: (open: boolean) => void;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={draft !== null}>
			<DialogContent className="sm:max-w-lg">
				{draft ? (
					<ServiceForm
						draft={draft}
						onDone={() => onOpenChange(false)}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
