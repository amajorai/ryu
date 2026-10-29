/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import {
	fetchGatewayConfig,
	type GatewayConfigSnapshot,
} from "@ryuhq/core-client/gateway";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";

const FIELDS = [
	"enabled",
	"scan_inbound",
	"scan_outbound",
	"log_detections",
	"redact_pii",
	"redact_secrets",
] as const;
const LABELS = [
	"Firewall",
	"Scan inbound",
	"Scan outbound",
	"Log detections",
	"Redact PII",
	"Redact secrets",
	"Policy",
	"Command approval",
];
const POLICIES = ["block", "warn_and_continue", "sanitize"] as const;
const APPROVAL_KEY = "exec-approval-mode";
const editablePolicyBooleanSchema = z.boolean();
// Widen only the native Array.includes input ABI; the tuple and its receiver
// remain unchanged. Includes accepts any search value without coercion.
const nativePolicyChoices: readonly unknown[] = POLICIES;
interface NativeFirewallReadObservation {
	enabled?: unknown;
	log_detections?: unknown;
	policy?: unknown;
	redact_pii?: unknown;
	redact_secrets?: unknown;
	scan_inbound?: unknown;
	scan_outbound?: unknown;
}
interface EditableFirewallObservation {
	enabled: boolean;
	log_detections: boolean;
	policy: (typeof POLICIES)[number];
	redact_pii: boolean;
	redact_secrets: boolean;
	scan_inbound: boolean;
	scan_outbound: boolean;
}
function hasEditableFirewall(
	config: GatewayConfigSnapshot
): config is GatewayConfigSnapshot & { firewall: EditableFirewallObservation } {
	// SAFETY: these are opaque optional property observations at the original
	// reads. Native property access boxes primitives and throws on nullish values;
	// no object identity, full Firewall DTO, or stable getter is asserted. The
	// original six boolean checks and native policy membership prove only the
	// consumed fields, retaining the untouched raw section and future fields.
	return !(
		FIELDS.some(
			(field) =>
				!editablePolicyBooleanSchema.safeParse(
					(config.firewall as NativeFirewallReadObservation)[field]
				).success
		) ||
		!nativePolicyChoices.includes(
			(config.firewall as NativeFirewallReadObservation).policy
		)
	);
}
const approvalPreferenceSchema = z.object({
	value: z.string().nullable().optional().catch(undefined),
});

interface Snapshot {
	approval: boolean;
	firewall: EditableFirewallObservation;
}

interface SaveIntent {
	expected: Snapshot;
	row: number;
}

export function GatewayPolicyEditor() {
	const { target } = useCore();
	const { checkConsoleAccess } = useCliProductMode();
	const theme = useTheme();
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [row, setRow] = useState(0);
	const [allowed, setAllowed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const generation = useRef(0);
	const working = useRef(false);
	const intent = useRef<SaveIntent | null>(null);

	const read = useCallback(async (): Promise<Snapshot> => {
		const [config, approval] = await Promise.all([
			fetchGatewayConfig(target),
			request(
				target,
				`/api/preferences/${APPROVAL_KEY}`,
				{},
				appResponseValueSchema
			).then((raw) => approvalPreferenceSchema.parse(raw)),
		]);
		if (!hasEditableFirewall(config)) {
			throw new Error("This Gateway does not serve editable firewall policy.");
		}
		return {
			firewall: config.firewall,
			approval:
				approval.value == null || approval.value.trim().toLowerCase() !== "off",
		};
	}, [target]);

	const load = useCallback(async () => {
		const sequence = ++generation.current;
		setSnapshot(null);
		setAllowed(false);
		setBusy(false);
		intent.current = null;
		setMessage(null);
		try {
			const [access, value] = await Promise.all([checkConsoleAccess(), read()]);
			if (sequence !== generation.current) {
				return;
			}
			setAllowed(access);
			setSnapshot(value);
			if (!access) {
				setMessage("Owner or admin access is required to edit policy.");
			}
		} catch {
			if (sequence === generation.current) {
				setMessage("Could not load policy. Press r to retry.");
			}
		}
	}, [checkConsoleAccess, read]);

	useEffect(() => {
		void load();
		return () => {
			generation.current += 1;
		};
	}, [load]);

	const save = async () => {
		if (!(snapshot && allowed) || working.current) {
			return;
		}
		working.current = true;
		setBusy(true);
		setMessage(null);
		const sequence = generation.current;
		const selected = row;
		try {
			if (!(await checkConsoleAccess())) {
				if (sequence === generation.current) {
					setAllowed(false);
					setMessage("Owner or admin access is required to edit policy.");
				}
				return;
			}
			let expected =
				intent.current?.row === selected ? intent.current.expected : null;
			if (!expected) {
				const before = await read();
				if (sequence !== generation.current) {
					return;
				}
				if (selected === 7) {
					expected = { ...before, approval: !before.approval };
				} else {
					const firewall = { ...before.firewall };
					if (selected === 6) {
						firewall.policy =
							POLICIES[
								(POLICIES.indexOf(firewall.policy) + 1) % POLICIES.length
							]!;
					} else {
						const field = FIELDS[selected]!;
						firewall[field] = !firewall[field];
					}
					expected = { ...before, firewall };
				}
				intent.current = { row: selected, expected };
			}
			if (sequence !== generation.current) {
				return;
			}
			if (selected === 7) {
				await request(
					target,
					`/api/preferences/${APPROVAL_KEY}`,
					{
						method: "PUT",
						body: { value: expected.approval ? "enforce" : "off" },
					},
					appResponseValueSchema
				);
			} else {
				await request(
					target,
					"/api/gateway/config",
					{
						method: "PUT",
						body: { firewall: expected.firewall },
					},
					appResponseValueSchema
				);
			}
			const after = await read();
			const matches =
				selected === 7
					? after.approval === expected.approval
					: JSON.stringify(after.firewall) ===
						JSON.stringify(expected.firewall);
			if (sequence !== generation.current) {
				return;
			}
			setSnapshot(after);
			if (matches) {
				intent.current = null;
			}
			setMessage(
				matches
					? "Saved and read back from this node."
					: "Saved response did not match readback. Press r to reload."
			);
		} catch {
			if (sequence === generation.current) {
				setMessage(
					"Could not save policy. Press Enter to retry or r to reload."
				);
			}
		} finally {
			working.current = false;
			if (sequence === generation.current) {
				setBusy(false);
			}
		}
	};

	useKeyboard((key) => {
		if (key.name === "r" && !working.current) {
			void load();
			return;
		}
		if (key.name === "up") {
			setRow((value) => Math.max(0, value - 1));
		}
		if (key.name === "down") {
			setRow((value) => Math.min(LABELS.length - 1, value + 1));
		}
		if (key.name === "return") {
			void save();
		}
	});

	return (
		<box flexDirection="column" gap={0}>
			<text fg={theme.colors.primary}>Node policy</text>
			<text fg={theme.colors.mutedForeground}>
				↑/↓ select · Enter change · j/k section · r reload
			</text>
			{snapshot ? (
				LABELS.map((label, index) => {
					const value =
						index === 7
							? snapshot.approval
							: index === 6
								? snapshot.firewall.policy
								: snapshot.firewall[FIELDS[index]!];
					return (
						<text
							fg={
								row === index ? theme.colors.primary : theme.colors.foreground
							}
							key={label}
						>
							{row === index ? "›" : " "} {label}:{" "}
							{value === true ? "On" : value === false ? "Off" : value}
						</text>
					);
				})
			) : (
				<text>
					{message ? "Node policy unavailable." : "Loading node policy…"}
				</text>
			)}
			{busy ? <text>Saving policy…</text> : null}
			{message ? (
				<text fg={theme.colors.mutedForeground}>{message}</text>
			) : null}
		</box>
	);
}
