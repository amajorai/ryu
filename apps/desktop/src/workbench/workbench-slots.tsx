import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

interface SlotRegistration {
	element: HTMLElement;
	sequence: number;
}

export interface WorkbenchSlotsValue {
	getSlot: (groupId: string, itemId: string) => HTMLElement | null;
	registerSlot: (groupId: string, itemId: string, element: HTMLElement) => void;
	slotEpoch: number;
	unregisterSlot: (
		groupId: string,
		itemId: string,
		element: HTMLElement
	) => void;
}

const WorkbenchSlotsContext = createContext<WorkbenchSlotsValue | null>(null);

const NOOP_SLOTS: WorkbenchSlotsValue = {
	getSlot: () => null,
	registerSlot: () => undefined,
	slotEpoch: 0,
	unregisterSlot: () => undefined,
};

function slotKey(groupId: string, itemId: string): string {
	return `${groupId}:${itemId}`;
}

export function useWorkbenchSlots(): WorkbenchSlotsValue {
	return useContext(WorkbenchSlotsContext) ?? NOOP_SLOTS;
}

export function WorkbenchSlotProvider({ children }: { children: ReactNode }) {
	const slotsRef = useRef<Record<string, SlotRegistration>>({});
	const sequenceRef = useRef(0);
	const [slotEpoch, setSlotEpoch] = useState(0);

	const registerSlot = useCallback(
		(groupId: string, itemId: string, element: HTMLElement) => {
			sequenceRef.current += 1;
			slotsRef.current[slotKey(groupId, itemId)] = {
				element,
				sequence: sequenceRef.current,
			};
			setSlotEpoch((current) => current + 1);
		},
		[]
	);

	const unregisterSlot = useCallback(
		(groupId: string, itemId: string, element: HTMLElement) => {
			const key = slotKey(groupId, itemId);
			const current = slotsRef.current[key];
			if (current?.element !== element) {
				return;
			}
			delete slotsRef.current[key];
			setSlotEpoch((epoch) => epoch + 1);
		},
		[]
	);

	const getSlot = useCallback((groupId: string, itemId: string) => {
		return slotsRef.current[slotKey(groupId, itemId)]?.element ?? null;
	}, []);

	const value = useMemo<WorkbenchSlotsValue>(
		() => ({ getSlot, registerSlot, slotEpoch, unregisterSlot }),
		[getSlot, registerSlot, slotEpoch, unregisterSlot]
	);

	return (
		<WorkbenchSlotsContext.Provider value={value}>
			{children}
		</WorkbenchSlotsContext.Provider>
	);
}
