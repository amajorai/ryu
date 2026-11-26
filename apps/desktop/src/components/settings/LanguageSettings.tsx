import { useI18n, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
	AUTO_DETECT_VALUE,
	DEFAULT_PACK_VALUE,
	useLanguageChoice,
} from "@/src/hooks/useLanguageChoice.ts";
import { downloadLanguagePack } from "@/src/lib/api/language-packs.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** App-level locale and flavor-pack picker shared by native desktop and webapp. */
export function LanguageSettings({
	settingsId = "appearance.language",
}: {
	settingsId?: string;
} = {}) {
	const navigate = useNavigate();
	const { direction, t } = useI18n();
	const tl = useLiteralMessages();
	const {
		busyId,
		importFile,
		languageMode,
		operationError,
		packs,
		select,
		selectedPack,
		value,
	} = useLanguageChoice();
	const importInputRef = useRef<HTMLInputElement>(null);

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
								value={value}
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
										aria-label={tl("Export {name}", { name: pack.name })}
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
