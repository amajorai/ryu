import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useState } from "react";
import { sileo } from "sileo";
import { DEFAULT_API, errMessage } from "./LlmProvidersSettings-shared.ts";
import { SpendLimitConfirm } from "./shared/provider-key-safety.tsx";
import { SettingsCard } from "./shared/settings-items.tsx";

interface CustomProviderFormProps {
	apiTypes: string[];
	onCreate: (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => Promise<void>;
}

// The "custom OpenAI-compatible provider" affordance — base URL + optional key +
// api type + a user-named id → POST /providers, which then surfaces it in the
// list above like any other provider.
export function CustomProviderForm({
	apiTypes,
	onCreate,
}: CustomProviderFormProps) {
	const [id, setId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [limitConfirmed, setLimitConfirmed] = useState(false);
	const [api, setApi] = useState(DEFAULT_API);
	const [saving, setSaving] = useState(false);

	const hasKey = apiKey.trim() !== "";
	const canCreate =
		id.trim() !== "" &&
		baseUrl.trim() !== "" &&
		!saving &&
		(!hasKey || limitConfirmed);

	const handleCreate = async () => {
		setSaving(true);
		try {
			await onCreate({
				provider: id.trim(),
				baseUrl: baseUrl.trim(),
				apiKey: apiKey.trim() || null,
				api,
			});
			setId("");
			setBaseUrl("");
			setApiKey("");
			setLimitConfirmed(false);
			setApi(DEFAULT_API);
			sileo.success({ title: "Custom provider added" });
		} catch (e) {
			sileo.error({
				title: "Could not add provider",
				description: errMessage(e, "Core rejected the request."),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsCard className="flex flex-col gap-3 py-3">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="custom-id">Provider id</Label>
					<Input
						id="custom-id"
						onChange={(e) => setId(e.target.value)}
						placeholder="ollama"
						value={id}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="custom-api">API type</Label>
					<Select
						items={apiTypes.map((a) => ({ value: a, label: a }))}
						onValueChange={(v) => setApi(v ?? DEFAULT_API)}
						value={api}
					>
						<SelectTrigger className="w-full" id="custom-api">
							<SelectValue placeholder="API type" />
						</SelectTrigger>
						<SelectContent>
							{apiTypes.map((a) => (
								<SelectItem key={a} value={a}>
									{a}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5 sm:col-span-2">
					<Label htmlFor="custom-url">Base URL</Label>
					<Input
						id="custom-url"
						onChange={(e) => setBaseUrl(e.target.value)}
						placeholder="http://localhost:11434/v1"
						value={baseUrl}
					/>
				</div>
				<div className="flex flex-col gap-1.5 sm:col-span-2">
					<Label htmlFor="custom-key">API key (optional)</Label>
					<Input
						autoComplete="off"
						id="custom-key"
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="Leave blank for keyless local servers"
						type="password"
						value={apiKey}
					/>
					{hasKey ? (
						<SpendLimitConfirm
							checked={limitConfirmed}
							id="custom-key-limit"
							onCheckedChange={setLimitConfirmed}
							providerId={id.trim()}
							providerLabel="this provider"
						/>
					) : null}
				</div>
			</div>
			<div className="flex justify-end">
				<Button
					disabled={!canCreate}
					onClick={handleCreate}
					size="sm"
					variant="mono"
				>
					{saving ? "Adding…" : "Add provider"}
				</Button>
			</div>
		</SettingsCard>
	);
}
