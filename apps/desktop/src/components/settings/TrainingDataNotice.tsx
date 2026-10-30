import { Button } from "@ryu/ui/components/button.tsx";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { PRIVACY_DOCS_PATH } from "./privacy-disclosure-state.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** The public page that carries the full commitment, its source and legal links. */
export const TRAINING_COMMITMENT_URL = `${FRONTEND_URL}${PRIVACY_DOCS_PATH}#training-commitment`;

/**
 * The training commitment as one flush row: the promise, one supporting line,
 * and "Learn more". The full text, the open-source repository and the Privacy
 * and Terms links live on the public transparency page it opens.
 */
export function TrainingDataNotice() {
	const openDetails = () => {
		void Promise.resolve(openExternal(TRAINING_COMMITMENT_URL)).catch(
			() => undefined
		);
	};

	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Button onClick={openDetails} size="sm" variant="outline">
							Learn more
						</Button>
					}
					description="Your chats, files and activity never train Ryu models."
					title="We never train on your data."
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
