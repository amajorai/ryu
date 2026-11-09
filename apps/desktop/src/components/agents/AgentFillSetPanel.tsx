import { formatList } from "@ryu/i18n";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentFillSetItemRow } from "@/src/components/agents/AgentFillSetItemRow.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { vaultErrorMessage } from "@/src/components/vault/vault-errors.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	attachAgentFillSet,
	type BoxFillChoice,
	defaultBoxFillChoice,
	FILL_SET_TTL_CHOICES,
	type FillSet,
	fetchAgentFillSets,
	fillSetItemRef,
	MAX_FILL_SET_ITEMS,
	parseFillSetText,
	revokeAgentFillSet,
	withBoxFillChoices,
} from "@/src/lib/api/agent-fill-sets.ts";
import { toTarget } from "@/src/lib/api/client.ts";

const ITEMS_FIELD_ID = "agent-fill-set-items";
const ENVIRONMENT_FIELD_ID = "agent-fill-set-environment";

/** Core's `vault_…: …` refusal as the vault pages show it, translated. */
function errorText(
	cause: unknown,
	fallback: string,
	tl: LiteralMessage
): string {
	return vaultErrorMessage(cause, tl(fallback), tl);
}

function ttlLabel(seconds: number): string {
	if (seconds === 3600) {
		return "1 hour";
	}
	return seconds === 4 * 3600 ? "4 hours" : "24 hours";
}

function ActiveSet({
	busy,
	onRevoke,
	set,
}: {
	busy: boolean;
	onRevoke: () => void;
	set: FillSet;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-3">
			<ul className="flex flex-col gap-1 text-sm">
				{set.items.map((item) => (
					<li className="flex justify-between gap-3" key={item.handle}>
						<span className="truncate font-mono text-xs">
							{item.path === "/" ? "" : item.path}
							{item.path === "/" ? "" : "/"}
							{item.key}
						</span>
						<span className="truncate text-muted-foreground text-xs">
							{item.host}
						</span>
					</li>
				))}
			</ul>
			<p className="text-muted-foreground text-xs">
				{tl("Expires {time}.", {
					time: new Date(set.expires_at).toLocaleString(),
				})}{" "}
				{set.claimed
					? "In use by the agent's current browser session."
					: "Not used yet: the first browser session that fills from it keeps it."}
			</p>
			<div className="flex justify-end">
				<Button
					disabled={busy}
					onClick={onRevoke}
					type="button"
					variant="outline"
				>
					Revoke attached items
				</Button>
			</div>
		</div>
	);
}

/**
 * Attach the user's own vault items to one agent's browser session, so the
 * agent can sign in with them without seeing a value, and revoke them.
 */
export function AgentFillSetPanel({
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
	const [active, setActive] = useState<FillSet | null>(null);
	const [text, setText] = useState("");
	const [environment, setEnvironment] = useState("");
	const [ttl, setTtl] = useState<number>(FILL_SET_TTL_CHOICES[0]);
	const [choices, setChoices] = useState<ReadonlyMap<string, BoxFillChoice>>(
		() => new Map()
	);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		() => fetchAgentFillSets(target, agentId).then((sets) => sets[0] ?? null),
		[agentId, target]
	);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		load()
			.then((set) => {
				if (!cancelled) {
					setActive(set);
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(errorText(cause, "Attached items could not be loaded.", tl));
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
	}, [load, tl]);

	const parsed = parseFillSetText(text, environment);
	const tooMany = parsed.items.length > MAX_FILL_SET_ITEMS;
	const busy = disabled || saving;

	const run = async (action: () => Promise<void>, fallback: string) => {
		setSaving(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(errorText(cause, fallback, tl));
		} finally {
			setSaving(false);
		}
	};

	const attach = () =>
		run(async () => {
			const items = withBoxFillChoices(parsed.items, choices);
			setActive(await attachAgentFillSet(target, agentId, items, ttl));
			setText("");
			setChoices(new Map());
		}, "The items were not attached.");

	const revoke = () =>
		run(async () => {
			if (active) {
				await revokeAgentFillSet(target, active.id);
			}
			setActive(await load());
		}, "The attached items were not revoked.");

	return (
		<SettingsSection
			caption="Let this agent sign in to sites with your own vault items. It fills them into the page without ever seeing them."
			title="Attached sign-ins"
		>
			{loading ? (
				<SkeletonRows label="Loading attached items…" spacing="comfortable" />
			) : (
				<SettingsCard className="flex flex-col gap-4">
					{active ? (
						<ActiveSet busy={busy} onRevoke={() => revoke()} set={active} />
					) : (
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-2">
								<Label htmlFor={ITEMS_FIELD_ID}>Items, one per line</Label>
								<Textarea
									disabled={busy}
									id={ITEMS_FIELD_ID}
									onChange={(event) => setText(event.target.value)}
									placeholder={"logins/github https://github.com"}
									rows={4}
									spellCheck={false}
									value={text}
									variant="code-caption"
								/>
								<p className="text-muted-foreground text-xs">
									Write folder/key, then optionally the site it fills on.
									Without a site, the item's first URL is used. You need read
									access to every item, and cards can't be attached.
								</p>
							</div>
							{parsed.items.length > 0 && !tooMany ? (
								<ul
									aria-label="Box fill for each item"
									className="flex flex-col gap-2"
								>
									{parsed.items.map((item, index) => {
										const ref = fillSetItemRef(item);
										return (
											<AgentFillSetItemRow
												choice={choices.get(ref) ?? defaultBoxFillChoice(item)}
												disabled={busy}
												index={index}
												item={item}
												key={`${index}:${ref}`}
												onChange={(next) =>
													setChoices((current) =>
														new Map(current).set(ref, next)
													)
												}
											/>
										);
									})}
								</ul>
							) : null}
							<div className="flex flex-col gap-2">
								<Label htmlFor={ENVIRONMENT_FIELD_ID}>Environment</Label>
								<Input
									disabled={busy}
									id={ENVIRONMENT_FIELD_ID}
									onChange={(event) => setEnvironment(event.target.value)}
									placeholder="default"
									value={environment}
								/>
							</div>
							<fieldset
								aria-label="How long the agent may use them"
								className="m-0 inline-flex min-w-0 items-center self-start rounded-lg border p-0.5"
							>
								{FILL_SET_TTL_CHOICES.map((seconds) => (
									<Button
										appearance={
											ttl === seconds ? "island-tab-active" : "default"
										}
										aria-pressed={ttl === seconds}
										disabled={busy}
										key={seconds}
										onClick={() => setTtl(seconds)}
										size="tiny"
										type="button"
										variant="ghost"
									>
										{ttlLabel(seconds)}
									</Button>
								))}
							</fieldset>
							{parsed.invalidLines.length > 0 ? (
								<p className="text-sm text-status-destructive" role="alert">
									{tl(
										"{count, plural, one {Line {lines} is not folder/key followed by a site.} other {Lines {lines} are not folder/key followed by a site.}}",
										{
											count: parsed.invalidLines.length,
											lines: formatList(parsed.invalidLines.map(String)),
										}
									)}
								</p>
							) : null}
							{tooMany ? (
								<p className="text-sm text-status-destructive" role="alert">
									{tl("Attach at most {max} items.", {
										max: MAX_FILL_SET_ITEMS,
									})}
								</p>
							) : null}
							<div className="flex justify-end">
								<Button
									disabled={
										busy ||
										tooMany ||
										parsed.items.length === 0 ||
										parsed.invalidLines.length > 0
									}
									loading={saving}
									onClick={() => attach()}
									type="button"
								>
									Attach items
								</Button>
							</div>
						</div>
					)}
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
				</SettingsCard>
			)}
		</SettingsSection>
	);
}
