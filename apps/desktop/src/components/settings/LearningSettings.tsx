// apps/desktop/src/components/settings/LearningSettings.tsx
//
// Consent controls for the Learning app: the on-device skill-synthesis loop
// (`learning.skills-enabled`, default OFF) and the heavier rate-and-retrain loop
// (`learning.enabled`, default OFF). Both persist as Core preferences; the
// defaults live in `lib/api/preferences.ts`, not here.
//
// The tab is manifest-registered — `contributes.settings_tabs` on
// `@ryu/learning`, node scope — and bound to this component by plugin id in
// EntitySettings. The app is pre-installed because Core's scheduler runs the skill
// synthesis pass off `learning.skills-enabled` alone (default OFF), regardless of
// the app record — only the HTTP surface is gated — so the consent control has to
// exist wherever that capture does.

import { toast } from "@ryu/ui/components/sileo.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	getLearningEnabled,
	getLearningSkillsEnabled,
	setLearningEnabled,
	setLearningSkillsEnabled,
} from "@/src/lib/api/preferences.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function LearningSettings() {
	const { url, token, userJwt } = toTarget(useActiveNode());
	const target = useMemo(
		() => ({ url, token, userJwt }),
		[url, token, userJwt]
	);
	return (
		<NodeLearningSettings
			key={JSON.stringify([url, token, userJwt ?? null])}
			target={target}
		/>
	);
}

function NodeLearningSettings({ target }: { target: ApiTarget }) {
	const [learningEnabled, setLearningEnabledState] = useState(false);
	const [skillsEnabled, setSkillsEnabledState] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [readError, setReadError] = useState(false);
	const [readAttempt, setReadAttempt] = useState(0);
	const [pending, setPending] = useState({ skills: false, learning: false });
	const pendingWrites = useRef(new Set<"skills" | "learning">());
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		setReadError(false);
		Promise.all([getLearningEnabled(target), getLearningSkillsEnabled(target)])
			.then(([learning, skills]) => {
				if (cancelled) return;
				setLearningEnabledState(learning);
				setSkillsEnabledState(skills);
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) setReadError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [target, readAttempt]);

	async function handleChange(kind: "skills" | "learning", next: boolean) {
		if (!loaded || pendingWrites.current.has(kind)) return;
		pendingWrites.current.add(kind);
		setPending((previous) => ({ ...previous, [kind]: true }));
		const setValue =
			kind === "skills" ? setSkillsEnabledState : setLearningEnabledState;
		const previous = kind === "skills" ? skillsEnabled : learningEnabled;
		setValue(next);
		try {
			const save =
				kind === "skills" ? setLearningSkillsEnabled : setLearningEnabled;
			if (!(await save(target, next))) throw new Error("Consent write refused");
		} catch {
			if (!mounted.current) return;
			setValue(previous);
			toast.error(
				kind === "skills"
					? "Couldn't save your skill-learning choice"
					: "Couldn't save your learning choice",
				{
					description: "Check your connection and try again.",
				}
			);
		} finally {
			if (mounted.current) {
				pendingWrites.current.delete(kind);
				setPending((current) => ({ ...current, [kind]: false }));
			}
		}
	}

	return (
		<div className="space-y-6">
			{readError && (
				<div role="alert">
					Couldn't load your learning choices.{" "}
					<Button onClick={() => setReadAttempt((attempt) => attempt + 1)}>
						Retry
					</Button>
				</div>
			)}
			<SettingsSection
				caption="Ryu learns from your conversations at two levels: a private one that never leaves this device, and a heavier one you opt into. You can leave out any individual conversation, and excluded conversations are never used."
				title="Learn from my conversations"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Learn skills from my chats"
								checked={skillsEnabled}
								id="learning-skills-enabled"
								disabled={!loaded || pending.skills}
								onCheckedChange={(next) => handleChange("skills", next)}
							/>
						}
						description="Off by default. When enabled, Ryu distills reusable skills from your chats on this device and proposes them in your Inbox for approval before they go live."
						title="Learn skills from my chats"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Train my local model"
								checked={learningEnabled}
								id="learning-enabled"
								disabled={!loaded || pending.learning}
								onCheckedChange={(next) => handleChange("learning", next)}
							/>
						}
						description="Off by default. Also rate your conversations with a stronger model and, on a device with a capable graphics card, fine-tune your local model on your best ones. Rating sends conversation text to that model, which may run in the cloud, so this stays opt-in."
						title="Train my local model"
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
