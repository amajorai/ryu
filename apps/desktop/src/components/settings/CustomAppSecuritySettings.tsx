import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_ENFORCE_CUSTOM_APP_CSP,
	getEnforceCustomAppCsp,
	setEnforceCustomAppCsp,
} from "@/src/lib/api/preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function CustomAppSecuritySettings({ target }: { target: ApiTarget }) {
	const userJwt = target.userJwt ?? null;
	const requestTarget = useMemo(
		() => ({ url: target.url, token: target.token, userJwt }),
		[target.url, target.token, userJwt]
	);
	const requestRevision = useRef(0);
	const [enforced, setEnforced] = useState(DEFAULT_ENFORCE_CUSTOM_APP_CSP);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const revision = ++requestRevision.current;
		setSaving(false);
		setLoading(true);
		setEnforced(DEFAULT_ENFORCE_CUSTOM_APP_CSP);
		getEnforceCustomAppCsp(requestTarget)
			.then((value) => {
				if (revision === requestRevision.current) {
					setEnforced(value);
				}
			})
			.catch(() => {
				// Keep the secure default if this node is unreachable.
			})
			.finally(() => {
				if (revision === requestRevision.current) {
					setLoading(false);
				}
			});
		return () => {
			requestRevision.current += 1;
		};
	}, [requestTarget]);

	const handleChange = useCallback(
		async (next: boolean) => {
			const revision = requestRevision.current;
			const previous = enforced;
			setSaving(true);
			setEnforced(next);
			try {
				await setEnforceCustomAppCsp(requestTarget, next);
			} catch {
				// A response from a former node or credential cannot alter this panel.
				if (revision !== requestRevision.current) {
					return;
				}
				setEnforced(previous);
				toast.error("Couldn't save the custom-app CSP setting", {
					description: "Check your connection and try again.",
				});
			} finally {
				if (revision === requestRevision.current) {
					setSaving(false);
				}
			}
		},
		[enforced, requestTarget]
	);

	return (
		<SettingsSection
			caption="On by default. Changes apply when a custom app is opened or reloaded."
			title="Custom app security"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Enforce CSP for custom apps"
							checked={enforced}
							disabled={loading || saving}
							id="enforce-custom-app-csp"
							onCheckedChange={handleChange}
						/>
					}
					description="When enabled, custom apps without a trusted CSP declaration use the restricted default CSP used in production. Turning this off allows direct network requests."
					title="Enforce CSP for custom apps"
				/>
			</SettingsGroup>
			<a
				className="text-primary text-sm underline underline-offset-2"
				href="https://developers.openai.com/plugins/build/chatgpt-ui#content-security-policy-csp"
				rel="noopener"
				target="_blank"
			>
				Learn more about CSP
			</a>
		</SettingsSection>
	);
}
