import { SECRET_LABELS } from "@ryu/blocks/desktop/channels.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";

/** One input per required credential, with its help text. */
export function ManualSecretFields({
	keys,
	onChange,
	secretHelp,
	secrets,
}: {
	keys: readonly string[];
	onChange: (key: string, value: string) => void;
	secretHelp: Partial<Record<string, string>>;
	secrets: Record<string, string>;
}) {
	return (
		<>
			{keys.map((key) => {
				const help = secretHelp[key];
				return (
					<div className="space-y-1.5" key={key}>
						<Label htmlFor={`dialog-secret-${key}`}>
							{SECRET_LABELS[key] ?? key}
						</Label>
						<Input
							aria-describedby={help ? `dialog-secret-${key}-help` : undefined}
							autoComplete="off"
							id={`dialog-secret-${key}`}
							name={`dialog-secret-${key}`}
							onChange={(e) => onChange(key, e.target.value)}
							placeholder="Paste value…"
							type={
								key === "openwa_url" || key === "webhook_url"
									? "url"
									: "password"
							}
							value={secrets[key] ?? ""}
						/>
						{help ? (
							<p
								className="text-detail text-muted-foreground"
								id={`dialog-secret-${key}-help`}
							>
								{help}
							</p>
						) : null}
					</div>
				);
			})}
		</>
	);
}
