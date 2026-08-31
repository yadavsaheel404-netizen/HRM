import { describe, expect, it } from "vitest";
import { classifyIdentifier, mapCellValue, parseLooseDate } from "./parse";
import { inspectSheet, transformSheet, type Grid } from "./sheet";

describe("parseLooseDate", () => {
  it("reads ordinal month-name dates", () => {
    expect(parseLooseDate("8th SEP 2025")).toMatchObject({ ok: true, date: "2025-09-08" });
  });

  it("survives the real-world '22dn' typo", () => {
    expect(parseLooseDate("22dn SEP 2025")).toMatchObject({ ok: true, date: "2025-09-22" });
  });

  it("handles curly and straight apostrophe years", () => {
    expect(parseLooseDate("2nd Feb'2026")).toMatchObject({ ok: true, date: "2026-02-02" });
    expect(parseLooseDate("2nd Feb\u20192026")).toMatchObject({ ok: true, date: "2026-02-02" });
  });

  it("reads unambiguous day-first slash dates", () => {
    expect(parseLooseDate("19/01/2026")).toMatchObject({ ok: true, date: "2026-01-19" });
    expect(parseLooseDate("27/2/2026")).toMatchObject({ ok: true, date: "2026-02-27" });
  });

  it("refuses to guess an ambiguous slash date", () => {
    const result = parseLooseDate("03/04/2026");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain("ambiguous");
  });

  it("reads ISO datetimes and Excel serials", () => {
    expect(parseLooseDate("2026-01-19T00:00:00.000Z")).toMatchObject({ ok: true, date: "2026-01-19" });
    expect(parseLooseDate("45901")).toMatchObject({ ok: true });
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseLooseDate("31/02/2026").ok).toBe(false);
  });
});

describe("mapCellValue", () => {
  it("maps the confirmed statuses", () => {
    expect(mapCellValue("Present")).toMatchObject({ kind: "attendance", workMode: "wfo" });
    expect(mapCellValue("Remote")).toMatchObject({ kind: "attendance", workMode: "wfh" });
    expect(mapCellValue("Leave")).toMatchObject({ exceptionType: "leave" });
    expect(mapCellValue("Half day")).toMatchObject({ halfDay: true });
    expect(mapCellValue("week-off")).toMatchObject({ kind: "calendar", calendarKind: "weekly_off" });
    expect(mapCellValue("Holiday")).toMatchObject({ kind: "calendar", calendarKind: "holiday" });
    expect(mapCellValue("Drop out")).toMatchObject({ kind: "signal", signalType: "exit" });
    expect(mapCellValue("Moved")).toMatchObject({ kind: "signal", signalType: "reassignment" });
  });

  it("treats stray numerics and unknown words as invalid, never as present", () => {
    expect(mapCellValue("31").kind).toBe("invalid");
    expect(mapCellValue("0").kind).toBe("invalid");
    expect(mapCellValue("whatever").kind).toBe("invalid");
    expect(mapCellValue("")).toEqual({ kind: "blank" });
  });
});

describe("classifyIdentifier", () => {
  it("auto-matches only organisation emails", () => {
    expect(classifyIdentifier("Aditya@theaischool.co.in").autoMatchable).toBe(true);
    expect(classifyIdentifier("someone@gmail.com").autoMatchable).toBe(false);
    expect(classifyIdentifier("Gigwork someone@gmail.com").kind).toBe("gigwork_email");
    expect(classifyIdentifier("204").kind).toBe("numeric_id");
    expect(classifyIdentifier("Buffer").kind).toBe("placeholder");
    expect(classifyIdentifier("").kind).toBe("missing");
  });
});

describe("wide-to-long transform", () => {
  const grid: Grid = [
    ["", "", "", "", "Mon", "Tue", "Wed", "Thu"],
    ["Name", "Working ID", "DOJ", "LWD", "1-Sep-2025", "2-Sep-2025", "3-Sep-2025", "4-Sep-2025"],
    ["Asha R", "asha@theaischool.co.in", "8th SEP 2025", "", "Present", "Remote", "week-off", "Half day"],
    ["Bare ID", "204", "22dn SEP 2025", "", "Present", "Leave", "31", "Moved"],
    ["", "", "", "", "", "", "", ""],
  ];

  const inspection = inspectSheet("ASR", grid);

  it("finds the header row, meta columns and date columns", () => {
    expect(inspection.headerRowIndex).toBe(1);
    expect(inspection.dateColumns).toHaveLength(4);
    expect(inspection.dateFrom).toBe("2025-09-01");
    expect(inspection.dateTo).toBe("2025-09-04");
    expect(inspection.rowCount).toBe(2);
  });

  it("produces one record per person per date, with signals captured once", () => {
    const people = transformSheet(grid, inspection);
    expect(people).toHaveLength(2);
    expect(people[0]!.cells).toHaveLength(4);
    expect(people[0]!.parsedDoj).toBe("2025-09-08");
    expect(people[0]!.identity.autoMatchable).toBe(true);
    expect(people[1]!.identity.autoMatchable).toBe(false);
    expect(people[1]!.cells[2]!.mapping.kind).toBe("invalid");
    expect(people[1]!.signals).toEqual([
      { signalType: "reassignment", effectiveDate: "2025-09-04", raw: "Moved" },
    ]);
  });
});
