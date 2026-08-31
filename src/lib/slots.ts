/** Fixed hourly slots for the working day (09:00–18:00 local).
 *
 *  Breaks are logged separately as break_logs, so no slot is removed for
 *  lunch — a lunch break simply overlaps the slot it happened in and the
 *  coverage maths already accounts for it.
 */
export type DaySlot = {
  /** Stable key, e.g. "09-10". */
  key: string;
  startHour: number;
  endHour: number;
  label: string;
};

const START_HOUR = 9;
const END_HOUR = 18;

const label12 = (hour: number) => {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00`;
};

export const DAY_SLOTS: DaySlot[] = Array.from(
  { length: END_HOUR - START_HOUR },
  (_, index): DaySlot => {
    const startHour = START_HOUR + index;
    const endHour = startHour + 1;
    return {
      key: `${String(startHour).padStart(2, "0")}-${String(endHour).padStart(2, "0")}`,
      startHour,
      endHour,
      label: `${label12(startHour)}–${label12(endHour)}`,
    };
  },
);

/** Local wall-clock boundaries of a slot on a given YYYY-MM-DD work date. */
export function slotRange(workDate: string, slot: DaySlot): { start: Date; end: Date } {
  const [y, m, d] = workDate.split("-").map(Number);
  const start = new Date(y!, (m ?? 1) - 1, d ?? 1, slot.startHour, 0, 0, 0);
  const end = new Date(y!, (m ?? 1) - 1, d ?? 1, slot.endHour, 0, 0, 0);
  return { start, end };
}

/** Matches an existing entry back to its slot by local start hour. */
export function slotKeyOf(startedAt: string, endedAt: string): string | null {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (start.getMinutes() !== 0 || end.getMinutes() !== 0) return null;
  if (end.getTime() - start.getTime() !== 3_600_000) return null;
  const slot = DAY_SLOTS.find((s) => s.startHour === start.getHours());
  return slot?.key ?? null;
}
