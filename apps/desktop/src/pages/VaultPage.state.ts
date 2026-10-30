import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sileo } from "sileo";
import type { VaultTransferMode } from "@/src/components/vault/VaultTransferDialog.tsx";
import { vaultErrorMessage } from "@/src/components/vault/vault-errors.ts";
import {
	buildFolderTree,
	inFolder,
	isVaultAdmin,
	normalizeFolder,
	ROOT_FOLDER,
	withSharedFallback,
} from "@/src/components/vault/vault-view.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultSecret,
	listVaultEnvironments,
	listVaultFolders,
	restoreVaultSecret,
	setVaultSecret,
	type VaultScope,
	type VaultSecret,
	vaultCoordsOf,
} from "@/src/lib/api/vault.ts";
import { vaultSecretsQuery } from "@/src/lib/route-queries.ts";
import { NAME_PATTERN, type VaultTab } from "./VaultPage.model.ts";

/** Vault queries, mutations, scope and environment selection, and the secret list model. */
export function useVaultPageState() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<VaultTab>("secrets");
	const [scope, setScope] = useState<VaultScope>("user");
	const [scopeId, setScopeId] = useState("");
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [bindingId, setBindingId] = useState("");
	const [formFolder, setFormFolder] = useState("");
	/** `null` follows the node's active environment. */
	const [environment, setEnvironment] = useState<string | null>(null);
	const [folder, setFolder] = useState(ROOT_FOLDER);
	const [showDeleted, setShowDeleted] = useState(false);
	const [detail, setDetail] = useState<VaultSecret | null>(null);
	const [transfer, setTransfer] = useState<VaultTransferMode | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<VaultSecret | null>(null);
	const vaultQuery = useQuery({
		...vaultSecretsQuery(target, {
			environment: environment ?? undefined,
			includeDeleted: showDeleted,
		}),
		placeholderData: keepPreviousData,
	});
	const state = vaultQuery.data;
	const activeEnvironment =
		environment ?? state?.activeEnvironment ?? "default";
	const environmentsQuery = useQuery({
		queryKey: ["vault", "environments", target.url],
		queryFn: () => listVaultEnvironments(target),
	});
	const foldersQuery = useQuery({
		queryKey: ["vault", "folders", target.url, activeEnvironment],
		queryFn: () => listVaultFolders(target, activeEnvironment),
	});
	const invalidateVault = async () => {
		await queryClient.invalidateQueries({ queryKey: ["vault"] });
	};
	const saveMutation = useMutation({
		mutationFn: async () => {
			const trimmedName = name.trim();
			if (!NAME_PATTERN.test(trimmedName)) {
				throw new Error(
					"Use a letter or underscore followed by letters, numbers, or underscores."
				);
			}
			if (scope === "team" && scopeId.trim() === "") {
				throw new Error("A team scope needs a team id.");
			}
			const result = await setVaultSecret(target, trimmedName, {
				scope,
				...(scope === "team" ? { scopeId: scopeId.trim() } : undefined),
				...(bindingId.trim()
					? { binding: { kind: "mcp" as const, id: bindingId.trim() } }
					: undefined),
				environment: activeEnvironment,
				path: formFolder.trim() ? normalizeFolder(formFolder) : folder,
				value,
			});
			return result.kind;
		},
		onSuccess: async (kind) => {
			setValue("");
			await invalidateVault();
			sileo.success({
				title: kind === "pending" ? "Sent for approval" : "Vault secret saved",
			});
		},
	});
	const deleteMutation = useMutation({
		mutationFn: async () => {
			if (!deleteTarget) {
				return null;
			}
			const result = await deleteVaultSecret(
				target,
				deleteTarget.name,
				vaultCoordsOf(deleteTarget)
			);
			return result.kind;
		},
		onSuccess: async (kind) => {
			setDeleteTarget(null);
			await invalidateVault();
			sileo.success({
				title:
					kind === "pending" ? "Sent for approval" : "Vault secret deleted",
			});
		},
	});
	const restoreMutation = useMutation({
		mutationFn: (secret: VaultSecret) =>
			restoreVaultSecret(target, secret.name, vaultCoordsOf(secret)),
		onSuccess: async () => {
			await invalidateVault();
			sileo.success({ title: "Vault secret restored" });
		},
		onError: (error) => {
			sileo.error({
				title: "Could not restore",
				description: vaultErrorMessage(error, "Try again."),
			});
		},
	});
	const availableScopes = useMemo(() => {
		const scopes: VaultScope[] = ["user", "node"];
		if (state?.node.orgId) {
			scopes.push("team", "org");
		}
		return scopes;
	}, [state?.node.orgId]);
	const teamIds = state?.caller?.teamIds ?? [];
	const sharedDisabled = Boolean(
		state?.node.orgId && !state.canManageShared && state.caller
	);
	const isAdmin = isVaultAdmin(state);
	const importScopes = availableScopes.filter(
		(item) => !(item === "org" && sharedDisabled)
	);
	const environmentOptions = useMemo(() => {
		const listed = environmentsQuery.data?.environments ?? [];
		const options = listed.map((item) => ({
			value: item.slug,
			label: item.name || item.slug,
			protected: item.protected,
		}));
		for (const slug of [activeEnvironment, state?.activeEnvironment]) {
			if (slug && !options.some((item) => item.value === slug)) {
				options.push({ value: slug, label: slug, protected: false });
			}
		}
		return options;
	}, [environmentsQuery.data, activeEnvironment, state?.activeEnvironment]);
	const selectedEnvironment = environmentOptions.find(
		(item) => item.value === activeEnvironment
	);
	const secretsInEnvironment = useMemo(
		() =>
			(state?.secrets ?? [])
				.filter((secret) => secret.environment === activeEnvironment)
				.map((secret) =>
					withSharedFallback(secret, state?.canManageShared ?? false)
				),
		[state?.secrets, state?.canManageShared, activeEnvironment]
	);
	const folderTree = useMemo(
		() =>
			buildFolderTree([
				...(foldersQuery.data ?? []),
				...secretsInEnvironment.map((secret) => secret.path),
			]),
		[foldersQuery.data, secretsInEnvironment]
	);
	const visibleSecrets = secretsInEnvironment.filter((secret) =>
		inFolder(secret.path, folder)
	);
	const selectScope = (next: string | null) => {
		if (
			next === "user" ||
			next === "node" ||
			next === "team" ||
			next === "org"
		) {
			setScope(next);
			if (next !== "team") {
				setScopeId("");
			}
		}
	};
	const selectEnvironment = (next: string) => {
		setEnvironment(next);
		setFolder(ROOT_FOLDER);
	};
	return {
		activeEnvironment,
		availableScopes,
		bindingId,
		deleteMutation,
		deleteTarget,
		detail,
		environmentOptions,
		folder,
		folderTree,
		formFolder,
		importScopes,
		invalidateVault,
		isAdmin,
		name,
		restoreMutation,
		saveMutation,
		scope,
		scopeId,
		selectEnvironment,
		selectScope,
		selectedEnvironment,
		setBindingId,
		setDeleteTarget,
		setDetail,
		setFolder,
		setFormFolder,
		setName,
		setScopeId,
		setShowDeleted,
		setTab,
		setTransfer,
		setValue,
		sharedDisabled,
		showDeleted,
		state,
		tab,
		target,
		teamIds,
		transfer,
		value,
		vaultQuery,
		visibleSecrets,
	};
}
