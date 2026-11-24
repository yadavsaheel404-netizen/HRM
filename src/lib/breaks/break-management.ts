/**
 * Domain rules and time calculations for employee breaks.
 * Client-safe, pure, and thoroughly unit-tested.
 *
 * Official daily schedule (Asia/Kolkata IST):
 * 1. Lunch Break: 1:30 PM – 2:30 PM IST (Fixed deadline: 2:30 PM IST)
 * 2. Short Break: 4:45 PM – 5:00 PM IST (Fixed deadline: 5:00 PM IST)
 * 3. Personalized Break: Custom approved duration, deadline = started_at + approved_minutes.
 */

export const BREAK_CATEGORIES = ["lunch", "short_break", "personal"] as const;
export type ValidBreakCategory = (typeof BREAK_CATEGORIES)[number];

export const BREAK_CATEGORY_DISPLAY: Record<ValidBreakCategory, string> = {
  lunch: "Lunch Break",
  short_break: "Short Break",
  personal: "Personalized Break",
};

export const LUNCH_WINDOW = {
  startHour: 13,
  startMinute: 30, // 1:30 PM IST
  endHour: 14,
  endMinute: 30, // 2:30 PM IST
  durationMinutes: 60,
} as const;

export const SHORT_BREAK_WINDOW = {
  startHour: 16,
  startMinute: 45, // 4:45 PM IST
  endHour: 17,
  endMinute: 0, // 5:00 PM IST
  durationMinutes: 15,
} as const;

export type WindowEvaluation =
  | { canStart: true; timeRemainingSeconds: number; expectedEndIso: string }
  | { canStart: false; reason: string; code: "before_window" | "after_window" };

export type ScheduledBreakEligibility =
  | {
      eligible: true;
      startedAtIso: string;
      expectedEndIso: string;
      allowedMinutes: number;
    }
  | {
      eligible: false;
      reason: string;
      code: "not_yet_due" | "late_checkin" | "not_checked_in" | "already_checked_out" | "after_window";
    };

/**
 * Evaluates whether a scheduled break (Lunch or Short Break) is eligible to be
 * auto-started or reconciled for a checked-in employee.
 */
export function evaluateScheduledBreakEligibility(
  category: "lunch" | "short_break",
  params: {
    checkInAt: string | Date | null | undefined;
    checkOutAt: string | Date | null | undefined;
    currentTime?: Date;
    workDate?: string;
  },
): ScheduledBreakEligibility {
  if (!params.checkInAt) {
    return {
      eligible: false,
      code: "not_checked_in",
      reason: "Employee is not checked in for today.",
    };
  }
  if (params.checkOutAt) {
    return {
      eligible: false,
      code: "already_checked_out",
      reason: "Employee has already checked out for today.",
    };
  }

  const currentIst = getIstWallClock(params.currentTime || new Date());
  const workDate = params.workDate || currentIst.workDate;
  const checkInIst = getIstWallClock(new Date(params.checkInAt));

  if (category === "lunch") {
    const windowStartSeconds = LUNCH_WINDOW.startHour * 3600 + LUNCH_WINDOW.startMinute * 60; // 13:30 = 48,600s
    const windowEndSeconds = LUNCH_WINDOW.endHour * 3600 + LUNCH_WINDOW.endMinute * 60; // 14:30 = 52,200s
    if (currentIst.totalSecondsFromMidnight < windowStartSeconds) {
      return {
        eligible: false,
        code: "not_yet_due",
        reason: "Lunch break automatically starts at 1:30 PM IST.",
      };
    }
    if (currentIst.totalSecondsFromMidnight > windowEndSeconds) {
      return {
        eligible: false,
        code: "after_window",
        reason: "Lunch break window (1:30 PM – 2:30 PM IST) has closed.",
      };
    }
    // If employee checked in after 1:30 PM IST, do not backdate a break they didn't take
    if (checkInIst.workDate === workDate && checkInIst.totalSecondsFromMidnight > windowStartSeconds) {
      return {
        eligible: false,
        code: "late_checkin",
        reason: "Employee checked in after scheduled lunch start time (1:30 PM IST).",
      };
    }

    return {
      eligible: true,
      startedAtIso: new Date(`${workDate}T13:30:00+05:30`).toISOString(),
      expectedEndIso: new Date(`${workDate}T14:30:00+05:30`).toISOString(),
      allowedMinutes: 60,
    };
  }

  // category === "short_break"
  const windowStartSeconds = SHORT_BREAK_WINDOW.startHour * 3600 + SHORT_BREAK_WINDOW.startMinute * 60; // 16:45 = 60,300s
  const windowEndSeconds = SHORT_BREAK_WINDOW.endHour * 3600 + SHORT_BREAK_WINDOW.endMinute * 60; // 17:00 = 61,200s
  if (currentIst.totalSecondsFromMidnight < windowStartSeconds) {
    return {
      eligible: false,
      code: "not_yet_due",
      reason: "Short break automatically starts at 4:45 PM IST.",
    };
  }
  if (currentIst.totalSecondsFromMidnight > windowEndSeconds) {
    return {
      eligible: false,
      code: "after_window",
      reason: "Short break window (4:45 PM – 5:00 PM IST) has closed.",
    };
  }
  // If employee checked in after 4:45 PM IST, do not backdate
  if (checkInIst.workDate === workDate && checkInIst.totalSecondsFromMidnight > windowStartSeconds) {
    return {
      eligible: false,
      code: "late_checkin",
      reason: "Employee checked in after scheduled short break start time (4:45 PM IST).",
    };
  }

  return {
    eligible: true,
    startedAtIso: new Date(`${workDate}T16:45:00+05:30`).toISOString(),
    expectedEndIso: new Date(`${workDate}T17:00:00+05:30`).toISOString(),
    allowedMinutes: 15,
  };
}

/**
 * Extracts Asia/Kolkata (IST) wall-clock time from a Date or timestamp.
 * IST is fixed UTC + 5:30 (+19,800,000 ms) with no daylight savings.
 */
export function getIstWallClock(date: Date = new Date()): {
  hours: number;
  minutes: number;
  seconds: number;
  totalSecondsFromMidnight: number;
  workDate: string;
} {
  const istDate = new Date(date.getTime() + (5 * 60 + 30) * 60_000);
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const seconds = istDate.getUTCSeconds();
  const totalSecondsFromMidnight = hours * 3600 + minutes * 60 + seconds;

  const y = istDate.getUTCFullYear();
  const m = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(istDate.getUTCDate()).padStart(2, "0");
  const workDate = `${y}-${m}-${d}`;

  return { hours, minutes, seconds, totalSecondsFromMidnight, workDate };
}

/**
 * Evaluates whether a fixed break (Lunch or Short Break) can be started right now.
 */
export function evaluateBreakWindow(
  category: "lunch" | "short_break",
  now: Date = new Date(),
  workDateOverride?: string,
): WindowEvaluation {
  const ist = getIstWallClock(now);
  const workDate = workDateOverride || ist.workDate;
  const currentTotalSeconds = ist.totalSecondsFromMidnight;

  if (category === "lunch") {
    const windowStartSeconds = LUNCH_WINDOW.startHour * 3600 + LUNCH_WINDOW.startMinute * 60; // 13:30 = 48,600s
    const windowEndSeconds = LUNCH_WINDOW.endHour * 3600 + LUNCH_WINDOW.endMinute * 60; // 14:30 = 52,200s

    if (currentTotalSeconds < windowStartSeconds) {
      return {
        canStart: false,
        reason: "Lunch opens at 1:30 PM.",
        code: "before_window",
      };
    }
    if (currentTotalSeconds >= windowEndSeconds) {
      return {
        canStart: false,
        reason: "Lunch window has closed for today.",
        code: "after_window",
      };
    }

    const expectedEndIso = new Date(`${workDate}T14:30:00+05:30`).toISOString();
    const timeRemainingSeconds = Math.max(0, windowEndSeconds - currentTotalSeconds);
    return { canStart: true, timeRemainingSeconds, expectedEndIso };
  }

  // Short Break
  const windowStartSeconds = SHORT_BREAK_WINDOW.startHour * 3600 + SHORT_BREAK_WINDOW.startMinute * 60; // 16:45 = 60,300s
  const windowEndSeconds = SHORT_BREAK_WINDOW.endHour * 3600 + SHORT_BREAK_WINDOW.endMinute * 60; // 17:00 = 61,200s

  if (currentTotalSeconds < windowStartSeconds) {
    return {
      canStart: false,
      reason: "Short break opens at 4:45 PM.",
      code: "before_window",
    };
  }
  if (currentTotalSeconds >= windowEndSeconds) {
    return {
      canStart: false,
      reason: "Short break window has closed for today.",
      code: "after_window",
    };
  }

  const expectedEndIso = new Date(`${workDate}T17:00:00+05:30`).toISOString();
  const timeRemainingSeconds = Math.max(0, windowEndSeconds - currentTotalSeconds);
  return { canStart: true, timeRemainingSeconds, expectedEndIso };
}

/**
 * Calculates the exact expected return deadline (UTC Date) for any break type.
 */
export function calculateExpectedReturn(
  category: ValidBreakCategory,
  workDate: string,
  startedAt: Date,
  approvedMinutes?: number | null,
): Date {
  if (category === "lunch") {
    // 2:30 PM IST on that work date
    return new Date(`${workDate}T14:30:00+05:30`);
  }
  if (category === "short_break") {
    // 5:00 PM IST on that work date
    return new Date(`${workDate}T17:00:00+05:30`);
  }
  // Personalized: started_at + approved_minutes
  const mins = approvedMinutes && approvedMinutes > 0 ? approvedMinutes : 15;
  return new Date(startedAt.getTime() + mins * 60_000);
}

export type OvertimeCalculation = {
  actualDurationSeconds: number;
  overtimeSeconds: number;
  returnStatus: "on_time" | "late_return";
};

/**
 * Calculates actual elapsed seconds and overtime when a break completes.
 */
export function calculateBreakCompletion(
  startedAt: Date | string,
  endedAt: Date | string,
  expectedEndAt: Date | string,
): OvertimeCalculation {
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const expectedMs = new Date(expectedEndAt).getTime();

  const actualDurationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const overtimeSeconds = Math.max(0, Math.round((endMs - expectedMs) / 1000));
  const returnStatus = overtimeSeconds > 0 ? "late_return" : "on_time";

  return { actualDurationSeconds, overtimeSeconds, returnStatus };
}

/** Formats seconds into HH:MM:SS or MM:SS */
export function formatDurationHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Always formats seconds as HH:MM:SS (e.g. 01:00:00, 00:45:00) */
export function formatFullHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Formats overtime as +HH:MM:SS */
export function formatOvertimeHms(overtimeSeconds: number): string {
  const s = Math.max(0, Math.floor(overtimeSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  return `+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Formats a timestamp into HH:MM:SS AM/PM IST */
export function formatTimeWithSecondsIst(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return "—";
  }
}

/** Formats duration compactly for human reading (e.g. "45s", "12m 30s", "1h 15m") */
export function formatDurationHuman(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const remS = seconds % 60;
  if (m < 60) {
    return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
