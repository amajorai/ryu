import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	LANGUAGE_MODE_CHANGED_EVENT,
	LANGUAGE_MODE_KEY,
	useLanguageMode,
} from "@/src/hooks/useLanguageMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	downloadLanguagePack,
	importLanguagePack,
	setLanguagePackEnabled,
} from "@/src/lib/api/language-packs.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const DEFAULT_PACK_VALUE = "__english__";
const AUTO_DETECT_VALUE = "__auto_detect__";

/** App-level locale and flavor-pack picker shared by native desktop and webapp. */
export function LanguageSettings({
	settingsId = "appearance.language",
}: {
	settingsId?: string;
} = {}) {
	const navigate = useNavigate();
	const node = useActiveNode();
	const { availablePacks, direction, selectedPack, selectPack, setLocale, t } =
		useI18n();
	const [languageMode, setLanguageMode] = useLanguageMode();
	const [busyId, setBusyId] = useState<string | null>(null);
	const [pendingPack, setPendingPack] = useState<{
		id: string;
		operation: symbol;
	} | null>(null);
	const [operationError, setOperationError] = useState<string | null>(null);
	const operationRef = useRef<symbol | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);
	const packs = useMemo(
		() =>
			availablePacks.filter(
				(pack) => pack.id !== "en-x-ryu-online" || pack.enabled !== false
			),
		[availablePacks]
	);
	const retireOperation = useCallback(() => {
		operationRef.current = null;
		setPendingPack(null);
		setBusyId(null);
		setOperationError(null);
	}, []);

	useEffect(() => {
		// An operation belongs to one node and credential generation. Returning
		// to an earlier owner must not revive a response from its previous visit.
		retireOperation();
		return () => {
			operationRef.current = null;
		};
	}, [node.url, node.token, node.userJwt, retireOperation]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (
				(event.storageArea === null || event.storageArea === localStorage) &&
				(event.key === null ||
					event.key === LANGUAGE_MODE_KEY ||
					event.key === LANGUAGE_PACK_STORAGE_KEY)
			) {
				retireOperation();
			}
		};
		window.addEventListener(LANGUAGE_MODE_CHANGED_EVENT, retireOperation);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(LANGUAGE_MODE_CHANGED_EVENT, retireOperation);
			window.removeEventListener("storage", onStorage);
		};
	}, [retireOperation]);

	const select = useCallback(
		async (value: string | null) => {
			retireOperation();
			if (value === AUTO_DETECT_VALUE) {
				setLanguageMode("auto");
				selectPack(null);
				setLocale(navigator.language);
				return;
			}
			const id = value === DEFAULT_PACK_VALUE ? null : value;
			const pack = id ? packs.find((candidate) => candidate.id === id) : null;
			if (pack && pack.enabled === false) {
				const operation = Symbol("language enable");
				operationRef.current = operation;
				setBusyId(pack.id);
				try {
					await setLanguagePackEnabled(toTarget(node), {
						enabled: true,
						id: pack.id,
					});
				} catch (error) {
					if (operationRef.current !== operation) {
						return;
					}
					setOperationError(
						error instanceof Error ? error.message : String(error)
					);
					setBusyId(null);
					operationRef.current = null;
					return;
				}
				if (operationRef.current !== operation) {
					return;
				}
				operationRef.current = null;
				setBusyId(null);
			}
			setLanguageMode("fixed");
			selectPack(id);
		},
		[node, packs, retireOperation, selectPack, setLanguageMode, setLocale]
	);

	useEffect(() => {
		if (
			!(
				pendingPack &&
				operationRef.current === pendingPack.operation &&
				availablePacks.some(
					(pack) => pack.id === pendingPack.id && pack.enabled !== false
				)
			)
		) {
			return;
		}
		operationRef.current = null;
		setLanguageMode("fixed");
		selectPack(pendingPack.id);
		setPendingPack(null);
	}, [availablePacks, pendingPack, selectPack, setLanguageMode]);

	const importFile = useCallback(
		async (file: File) => {
			retireOperation();
			const operation = Symbol("language import");
			operationRef.current = operation;
			setBusyId("__import__");
			try {
				const archive = new Uint8Array(await file.arrayBuffer());
				if (operationRef.current !== operation) {
					return;
				}
				const pack = await importLanguagePack(toTarget(node), archive);
				if (operationRef.current !== operation) {
					return;
				}
				setPendingPack({ id: pack.id, operation });
				window.dispatchEvent(
					new CustomEvent<LanguagePack>(LANGUAGE_PACKS_CHANGED_EVENT, {
						detail: pack,
					})
				);
			} catch (error) {
				if (operationRef.current !== operation) {
					return;
				}
				setOperationError(
					error instanceof Error
						? error.message
						: t(
								"language.import_failed",
								undefined,
								"Could not import language pack"
							)
				);
			} finally {
				if (operationRef.current === operation) {
					setBusyId(null);
				}
			}
		},
		[node, retireOperation, t]
	);

	return (
		<div className="space-y-6">
			<SettingsSection
				caption={t("language.restart_not_required")}
				headerAction={
					<>
						{/* The visible Import button is the control; this chooser is
							only opened from it, so it is neither a Tab stop nor announced. */}
						<input
							accept=".ryupack,application/zip"
							aria-hidden="true"
							className="sr-only"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) {
									void importFile(file);
								}
							}}
							ref={importInputRef}
							tabIndex={-1}
							type="file"
						/>
						<Button
							disabled={busyId !== null}
							onClick={() => importInputRef.current?.click()}
							size="sm"
							variant="secondary"
						>
							{t("common.import")}
						</Button>
					</>
				}
				title={t("language.title")}
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								onValueChange={(value) => {
									void select(value);
								}}
								value={
									languageMode === "auto"
										? AUTO_DETECT_VALUE
										: (selectedPack?.id ?? DEFAULT_PACK_VALUE)
								}
							>
								<SelectTrigger className="h-8 w-64" disabled={busyId !== null}>
									<SelectValue>
										{languageMode === "auto"
											? t("language.auto_detect")
											: (selectedPack?.name ?? t("common.english"))}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={AUTO_DETECT_VALUE}>
										{t("language.auto_detect")}
									</SelectItem>
									<SelectItem value={DEFAULT_PACK_VALUE}>
										{t("common.english")}
									</SelectItem>
									{packs.map((pack) => (
										<SelectItem key={pack.id} value={pack.id}>
											{pack.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={t("language.choose")}
						settingsId={settingsId}
						title={t("language.current")}
					/>
				</SettingsGroup>
			</SettingsSection>
			{operationError ? (
				<p className="text-detail text-status-destructive" role="alert">
					{operationError}
				</p>
			) : null}

			<SettingsSection title={t("language.available_packs")}>
				<SettingsGroup>
					{packs.map((pack) => (
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									{pack.id === selectedPack?.id ? (
										<span className="text-muted-foreground text-xs">
											{t("common.active")}
										</span>
									) : pack.enabled === false ? (
										<span className="text-muted-foreground text-xs">
											{t("language.pack_disabled")}
										</span>
									) : null}
									<Button
										aria-label={`${t("common.export")} ${pack.name}`}
										onClick={() => downloadLanguagePack(pack)}
										size="sm"
										variant="ghost"
									>
										{t("common.export")}
									</Button>
								</div>
							}
							description={`${pack.locale} · ${pack.direction === "rtl" ? t("language.direction_rtl") : t("language.direction_ltr")} · ${t("language.pack_version", { version: pack.version })}`}
							key={pack.id}
							title={pack.name}
						/>
					))}
					{packs.length === 0 ? (
						<SettingsItem title={t("language.no_packs")} />
					) : null}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection caption={t("language.fallback")}>
				<SettingsGroup>
					<SettingsItem
						actions={
							<button
								className="font-medium text-primary text-xs underline-offset-4 hover:underline"
								onClick={() => navigate("/marketplace")}
								type="button"
							>
								{t("common.marketplace")}
							</button>
						}
						title={t("language.download_from_marketplace")}
					/>
				</SettingsGroup>
			</SettingsSection>

			{selectedPack ? (
				<p className="text-detail text-muted-foreground">
					{t("language.translation_count", {
						count: Object.keys(selectedPack.messages).length,
					})}{" "}
					·{" "}
					{direction === "rtl"
						? t("language.direction_rtl")
						: t("language.direction_ltr")}
				</p>
			) : null}
		</div>
	);
}
