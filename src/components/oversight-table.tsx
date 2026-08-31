import { Badge } from "@/components/ui/badge";
import { ATTENDANCE_STATUS_LABELS } from "@/lib/daily.server";
import type { OversightRow } from "@/lib/oversight.server";

const PROBLEM = new Set([
  "review_required",
  "missed_check_out",
  "half_day",
  "present_hours_incomplete",
  "absent",
]);

export function OversightTable({
  rows,
  onSelect,
}: {
  rows: OversightRow[];
  onSelect?: (row: OversightRow) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No attendance days in this range.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Person</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Worked</th>
            <th className="py-2 pr-3 text-right">Task hrs</th>
            <th className="py-2 pr-3 text-right">Uncovered</th>
            <th className="py-2 pr-3 text-right">Units</th>
            <th className="py-2 pr-3 text-right">Target %</th>
            <th className="py-2 pr-3">Location</th>
            <th className="py-2 pr-3">EOD</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr
              key={row.dayId}
              className={onSelect ? "cursor-pointer hover:bg-muted/50" : undefined}
              onClick={() => onSelect?.(row)}
            >
              <td className="py-2 pr-3 font-medium">{row.fullName}</td>
              <td className="py-2 pr-3 tabular-nums">{row.workDate}</td>
              <td className="py-2 pr-3">
                <Badge variant={PROBLEM.has(row.status) ? "secondary" : "default"}>
                  {ATTENDANCE_STATUS_LABELS[row.status] ?? row.status}
                </Badge>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {(row.metrics.workedMinutes / 60).toFixed(2)}h
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{row.achievement.taskHours}h</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.metrics.uncoveredMinutes}m
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.achievement.unitsCompleted}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {row.achievement.dailyAchievementPct != null
                  ? `${row.achievement.dailyAchievementPct}%`
                  : "—"}
              </td>
              <td className="py-2 pr-3">
                <LocationCell row={row} />
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.eodStatus ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LOCATION_LABELS: Record<string, string> = {
  not_required: "Not required",
  verified: "Verified at office",
  failed: "Outside office",
  denied: "Permission denied",
  unavailable: "Unavailable",
};

function LocationCell({ row }: { row: OversightRow }) {
  if (row.locationStatus === "not_required") {
    return <span className="text-muted-foreground">—</span>;
  }
  const detail =
    row.locationDistanceM != null ? ` · ${Math.round(row.locationDistanceM)}m` : "";
  return (
    <span className="whitespace-nowrap text-xs">
      <Badge variant={row.locationStatus === "verified" ? "default" : "secondary"}>
        {LOCATION_LABELS[row.locationStatus] ?? row.locationStatus}
      </Badge>
      <span className="ml-1 text-muted-foreground">
        {row.officeName ?? ""}
        {detail}
      </span>
    </span>
  );
}

export const OVERSIGHT_CSV_COLUMNS = [
  { key: "person", header: "Person", value: (r: OversightRow) => r.fullName },
  { key: "date", header: "Work date", value: (r: OversightRow) => r.workDate },
  { key: "mode", header: "Work mode", value: (r: OversightRow) => r.workMode },
  { key: "in", header: "Check in", value: (r: OversightRow) => r.checkInAt ?? "" },
  { key: "out", header: "Check out", value: (r: OversightRow) => r.checkOutAt ?? "" },
  { key: "status", header: "Derived status", value: (r: OversightRow) => r.status },
  { key: "worked", header: "Worked minutes", value: (r: OversightRow) => r.metrics.workedMinutes },
  { key: "task", header: "Task minutes", value: (r: OversightRow) => r.metrics.taskMinutes },
  { key: "break", header: "Break minutes", value: (r: OversightRow) => r.metrics.breakMinutes },
  { key: "blocker", header: "Blocker minutes", value: (r: OversightRow) => r.metrics.blockerMinutes },
  {
    key: "uncovered",
    header: "Uncovered minutes",
    value: (r: OversightRow) => r.metrics.uncoveredMinutes,
  },
  { key: "units", header: "Units completed", value: (r: OversightRow) => r.achievement.unitsCompleted },
  { key: "project", header: "Project", value: (r: OversightRow) => r.projectCode ?? "" },
  { key: "dailyTarget", header: "Daily target", value: (r: OversightRow) => r.achievement.dailyTarget ?? "" },
  {
    key: "achievement",
    header: "Daily achievement %",
    value: (r: OversightRow) => r.achievement.dailyAchievementPct ?? "",
  },
  {
    key: "pace",
    header: "Pace achievement %",
    value: (r: OversightRow) => r.achievement.paceAchievementPct ?? "",
  },
  { key: "locStatus", header: "Location status", value: (r: OversightRow) => r.locationStatus },
  { key: "locOffice", header: "Office", value: (r: OversightRow) => r.officeName ?? "" },
  {
    key: "locDistance",
    header: "Distance from office (m)",
    value: (r: OversightRow) => (r.locationDistanceM == null ? "" : Math.round(r.locationDistanceM)),
  },
  { key: "eod", header: "EOD status", value: (r: OversightRow) => r.eodStatus ?? "" },
];
