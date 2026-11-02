/**
 * The Integrations tab's "Self-hosted relay public URL" field: the only writer
 * of the `webhook.ingress.url` pref. The tab owns the state and the save; this
 * renders the input, its Save button, and the unsaved-change notice.
 *
 * The self-hosted relay is the one backend that cannot discover a
 * URL for itself: Core deliberately refuses to fall back to the
 * loopback bind address (it would report a green ingress on an
 * address no sender can reach), so with no base the ingress errors
 * and stays down. This input is the only writer of the
 * `webhook.ingress.url` pref — the other supplier is the
 * `RYU_WEBHOOK_INGRESS_URL` env var, which the client cannot see.
 *
 * It renders whenever the picker OFFERS the self-hosted relay, not
 * when it is selected. Gating on the selection made this a control
 * you could only reach from a state Core now refuses to enter (it
 * 400s an own-relay selection with no usable URL), i.e. the pref's
 * sole writer sat behind its own precondition. The title and the
 * copy scope it to that one backend so it reads as "configure this
 * to enable Self-hosted relay" while another backend is active,
 * rather than as a URL the current backend uses.
 */
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SettingsItem } from "./shared/settings-items.tsx";

export function IngressUrlSetting({
	dirty,
	loaded,
	onChange,
	onSave,
	saving,
	value,
}: {
	/** The typed value differs from the saved one. */
	dirty: boolean;
	/** The saved value has been read; until then the field is locked. */
	loaded: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
	saving: boolean;
	value: string;
}) {
	return (
		<SettingsItem title="Self-hosted relay public URL">
			<div className="flex items-center gap-2">
				<Input
					aria-label="Self-hosted relay public URL"
					autoComplete="off"
					className="flex-1"
					disabled={!loaded}
					id="ingress-url"
					onChange={(e) => onChange(e.target.value)}
					placeholder="https://ryu.example.com"
					size="compact"
					type="url"
					value={value}
				/>
				<Button
					disabled={!loaded || saving || !dirty}
					onClick={onSave}
					size="sm"
				>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>
			{dirty && loaded ? (
				<p className="font-medium text-foreground text-xs">
					Not saved yet. Selecting Self-hosted relay checks the saved value, not
					what is typed here.
				</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				Save this first, then pick <em>Self-hosted relay</em> above: that
				backend serves whatever base is configured and this node refuses the
				selection until one is. Use the address this node is reachable at from
				the public internet: scheme and host, no path (your reverse proxy or
				tunnel); webhook paths are appended to it. The other backends publish a
				URL of their own and ignore this. Set{" "}
				<code>RYU_WEBHOOK_INGRESS_URL</code> in this node's environment instead
				if you prefer. It takes precedence over this field, and pins the backend
				to Self-hosted relay.
			</p>
		</SettingsItem>
	);
}
