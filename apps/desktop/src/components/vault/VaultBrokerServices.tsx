// Broker services: every service the caller can see, with Add (from the
// catalog or a blank form), Edit and Delete. Core refuses writes without
// `admin` on the service key and `use` on each credential it names, and the
// refusal is shown as sent. No values appear here.

import {
	Add01Icon,
	Delete02Icon,
	Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultBrokerService,
	listVaultBrokerServices,
	type VaultBrokerService,
} from "@/src/lib/api/vault-broker.ts";
import {
	type BrokerServiceDraft,
	VaultBrokerServiceDialog,
} from "./VaultBrokerServiceDialog.tsx";
import { whenLabel } from "./vault-broker-summary.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export function upstream(service: VaultBrokerService): string {
	const port = service.port ? `:${service.port}` : "";
	const prefix = service.pathPrefix === "/" ? "" : service.pathPrefix;
	return `${service.host}${port}${prefix}`;
}

function DeleteServiceDialog({
	onClose,
	service,
	target,
}: {
	onClose: () => void;
	service: VaultBrokerService | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const deleteMutation = useMutation({
		mutationFn: (name: string) => deleteVaultBrokerService(target, name),
		onSuccess: async (_, name) => {
			await queryClient.invalidateQueries({ queryKey: ["vault", "broker"] });
			sileo.success({ title: "Service deleted", description: name });
			onClose();
		},
	});
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					deleteMutation.reset();
					onClose();
				}
			}}
			open={service !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete this service?</AlertDialogTitle>
					<AlertDialogDescription>
						{tl(
							"Agents can no longer reach {host} through {name}. Sessions that named it keep running without it.",
							{
								host: service ? upstream(service) : "",
								name: service?.name ?? "",
							}
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{deleteMutation.error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{vaultErrorMessage(
							deleteMutation.error,
							"Could not delete the service.",
							tl
						)}
					</p>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={deleteMutation.isPending}
						onClick={(event) => {
							event.preventDefault();
							if (service) {
								deleteMutation.mutate(service.name);
							}
						}}
						variant="destructive"
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function BrokerServices({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState<BrokerServiceDraft | null>(null);
	const [deleting, setDeleting] = useState<VaultBrokerService | null>(null);
	const servicesQuery = useQuery({
		queryKey: ["vault", "broker", "services", target.url],
		queryFn: () => listVaultBrokerServices(target),
	});
	const services = servicesQuery.data ?? [];

	return (
		<SettingsSection
			caption="Agents started with the broker reach these hosts through a local proxy that adds the credential, so the agent never sees it."
			headerAction={
				<Button
					onClick={() => setDraft({ environment, mode: "create" })}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add service
				</Button>
			}
			title="Services"
		>
			<SettingsCard className="divide-y p-0">
				{servicesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={3} />
				) : servicesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							servicesQuery.error,
							"Could not load broker services.",
							tl
						)}
					</p>
				) : services.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No broker services yet.
					</p>
				) : (
					<ul className="divide-y">
						{services.map((service) => (
							<li
								className="flex items-start justify-between gap-4 px-4 py-3"
								key={`${service.environment}/${service.name}`}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<code className="font-medium font-mono">
											{service.name}
										</code>
										<Badge variant="outline">{service.environment}</Badge>
										{service.enabled ? null : (
											<Badge variant="secondary">Disabled</Badge>
										)}
									</p>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{[upstream(service), service.description]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<Button
										aria-label={tl("Edit {name}", { name: service.name })}
										onClick={() => setDraft({ mode: "edit", service })}
										size="icon-sm"
										variant="ghost-muted"
									>
										<HugeiconsIcon className="size-4" icon={Edit02Icon} />
									</Button>
									<Button
										aria-label={tl("Delete {name}", { name: service.name })}
										onClick={() => setDeleting(service)}
										size="icon-sm"
										variant="ghost-muted"
									>
										<HugeiconsIcon className="size-4" icon={Delete02Icon} />
									</Button>
									<span className="text-muted-foreground text-xs">
										{whenLabel(service.updatedAt)}
									</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultBrokerServiceDialog
				draft={draft}
				onOpenChange={(open) => {
					if (!open) {
						setDraft(null);
					}
				}}
				target={target}
			/>
			<DeleteServiceDialog
				onClose={() => setDeleting(null)}
				service={deleting}
				target={target}
			/>
		</SettingsSection>
	);
}
