import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { Logo as GhostOrb } from "@ryu/ui/components/logo.tsx";
import { createContext, type ReactNode, useContext, useState } from "react";
import { AgentAvatar } from "../../lib/agent-logos.tsx";

export interface OnboardingPersona {
	avatar: GlyphValue;
	name: string;
}

interface OnboardingPersonaContextValue extends OnboardingPersona {
	setPersona: (persona: OnboardingPersona) => void;
}

const defaultPersona: OnboardingPersonaContextValue = {
	avatar: null,
	name: "Ryu",
	setPersona: () => undefined,
};

const OnboardingPersonaContext =
	createContext<OnboardingPersonaContextValue>(defaultPersona);

export function RyuOnboardingPersonaProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [persona, setPersona] = useState<OnboardingPersona>({
		avatar: null,
		name: "Ryu",
	});

	return (
		<OnboardingPersonaContext.Provider value={{ ...persona, setPersona }}>
			{children}
		</OnboardingPersonaContext.Provider>
	);
}

export function useRyuOnboardingPersona(): OnboardingPersonaContextValue {
	return useContext(OnboardingPersonaContext);
}

export function RyuOnboardingAvatar({ size = 50 }: { size?: number }) {
	const { avatar } = useRyuOnboardingPersona();
	if (!avatar) {
		return <GhostOrb size={`${size}px`} variant="outline" />;
	}
	return (
		<AgentAvatar
			className="shrink-0"
			engine="ryu"
			glyph={avatar}
			presentation="portrait"
			size={`${size}px`}
		/>
	);
}
