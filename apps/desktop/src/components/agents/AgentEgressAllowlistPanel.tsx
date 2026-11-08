import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	clearAgentEgressAllowlist,
	fetchAgentEgressAllowlist,
	formatAllowlistText,
	MAX_EGRESS_ALLOWLIST_HOSTS,
	parseAllowlistText,
	saveAgentEgressAllowlist,
} from "@/src/lib/api/agent-egress-allowlist.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";

const HOSTS_FIELD_ID = "agent-egress-allowlist-hosts";

function errorText(cause: unknown, fallback: string): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error ? cause.message : fallback;
}

/**
 * Edit the hosts an agent's app sessions (a Bot browser session, for one) may
 * reach. Core stamps the saved list on the agent's verified app requests.
 */
export function AgentEgressAllowlistPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const [stored, setStored] = useState<string[] | null>(null);
	const [limited, setLimited] = useState(false);
	const [text, setText] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const show = useCallback((allowlist: string[] | null) => {
		setStored(allowlist);
		setLimited(allowlist !== null);
		setText(formatAllowlistText(allowlist ?? []));
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		setSaved(false);
		fetchAgentEgressAllowlist(target, agentId)
			.then((allowlist) => {
				if (!cancelled) {
					show(allowlist);
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(
						errorText(cause, "The agent's allowed sites could not be loaded.")
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, show, target]);

	const entries = parseAllowlistText(text);
	const tooMany = limited && entries.length > MAX_EGRESS_ALLOWLIST_HOSTS;

	const handleSave = async () => {
		setSaving(true);
		setSaved(false);
		setError(null);
		try {
			if (limited) {
				show(await saveAgentEgressAllowlist(target, agentId, entries));
			} else {
				await clearAgentEgressAllowlist(target, agentId);
				show(null);
			}
			setSaved(true);
		} catch (cause) {
			setError(errorText(cause, "The agent's allowed sites were not saved."));
		} finally {
			setSaving(false);
		}
	};

	const busy = disabled || saving;
	const unchanged =
		limited === (stored !== null) &&
		formatAllowlistText(entries) === formatAllowlistText(stored ?? []);

	return (
		<SettingsSection
			caption="Limit the sites this agent's app sessions, such as its browser, may reach."
			title="Allowed sites"
		>
			{loading ? (
				<SkeletonRows label="Loading allowed sites…" spacing="comfortable" />
			) : (
				<SettingsCard className="flex flex-col gap-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="font-medium text-sm">
								Only reach the sites listed here
							</p>
							<p className="text-muted-foreground text-xs">
								{limited
									? "Requests to any other site are refused."
									: "Off: this agent's app sessions may reach any site."}
							</p>
						</div>
						<Switch
							aria-label="Only reach the sites listed here"
							checked={limited}
							disabled={busy}
							onCheckedChange={(checked) => {
								setLimited(checked);
								setSaved(false);
							}}
						/>
					</div>

					{limited ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor={HOSTS_FIELD_ID}>Sites, one per line</Label>
							<Textarea
								disabled={busy}
								id={HOSTS_FIELD_ID}
								onChange={(event) => {
									setText(event.target.value);
									setSaved(false);
								}}
								placeholder={"example.com\n*.example.org"}
								rows={4}
								spellCheck={false}
								value={text}
								variant="code-caption"
							/>
							<p className="text-muted-foreground text-xs">
								Use example.com for one host or *.example.com for its
								subdomains. An empty list blocks every site.
							</p>
							<p className="text-muted-foreground text-xs">
								A narrower list applies at once. A browser session that is
								already open keeps its list until it ends, so a wider list
								applies to the next session.
							</p>
							{tooMany ? (
								<p className="text-sm text-status-destructive" role="alert">
									{tl("List at most {max} sites.", {
										max: MAX_EGRESS_ALLOWLIST_HOSTS,
									})}
								</p>
							) : null}
						</div>
					) : null}

					<div className="flex justify-end">
						<Button
							disabled={busy || tooMany || unchanged}
							loading={saving}
							onClick={() => handleSave()}
							type="button"
						>
							Save allowed sites
						</Button>
					</div>

					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					{saved ? (
						<p className="text-muted-foreground text-xs">
							Allowed sites updated.
						</p>
					) : null}
				</SettingsCard>
			)}
		</SettingsSection>
	);
}
