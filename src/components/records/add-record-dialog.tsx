import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, FolderKanban, Info, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { describeUnknownError } from "@/lib/describe-error";
import { checkRecordDuplicates, createEmployeeRecord } from "@/lib/records.functions";
import {
  RECORD_CATEGORY_LABELS,
  RECORD_EMPLOYMENT_CATEGORIES,
  RECORD_WORK_TYPES,
  RECORD_WORK_TYPE_LABELS,
  validateGoogleDriveFolderUrl,
  type RecordEmploymentCategory,
  type RecordWorkType,
} from "@/lib/records/types";

type DuplicateMatch = {
  source: "records" | "workforce";
  id: string;
  code: string | null;
  displayName: string;
  organizationEmail: string | null;
  personalEmail: string | null;
  phoneNumber: string | null;
  employmentStatus: string;
  reason: string;
};

export function AddRecordDialog({
  open,
  onOpenChange,
  departments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departments: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [organizationEmail, setOrganizationEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [address, setAddress] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [lastWorkingDate, setLastWorkingDate] = useState("");
  const [employmentCategory, setEmploymentCategory] =
    useState<RecordEmploymentCategory>("unknown");
  const [workType, setWorkType] = useState<RecordWorkType>("unknown");
  const [departmentId, setDepartmentId] = useState("");
  const [designation, setDesignation] = useState("");
  const [employmentStatus, setEmploymentStatus] = useState<"active" | "inactive">("inactive");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [notes, setNotes] = useState("");

  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function resetForm() {
    setFirstName("");
    setLastName("");
    setPersonalEmail("");
    setOrganizationEmail("");
    setPhoneNumber("");
    setAddress("");
    setJoiningDate("");
    setLastWorkingDate("");
    setEmploymentCategory("unknown");
    setWorkType("unknown");
    setDepartmentId("");
    setDesignation("");
    setEmploymentStatus("inactive");
    setDriveFolderUrl("");
    setNotes("");
    setDuplicateMatches(null);
  }

  async function runDuplicateCheck() {
    if (!firstName.trim() && !personalEmail.trim() && !organizationEmail.trim() && !phoneNumber.trim()) {
      toast.error("Enter a name, email, or phone number before checking duplicates.");
      return;
    }
    try {
      setCheckingDuplicates(true);
      const res = await checkRecordDuplicates({
        data: {
          firstName,
          lastName,
          personalEmail,
          organizationEmail,
          phoneNumber,
        },
      });
      setDuplicateMatches(res.matches);
      if (res.matches.length === 0) {
        toast.success("No matching existing records or Workforce profiles found.");
      }
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setCheckingDuplicates(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim()) {
      toast.error("First Name is required.");
      return;
    }
    if (driveFolderUrl.trim()) {
      const check = validateGoogleDriveFolderUrl(driveFolderUrl);
      if (!check.valid) {
        toast.error(check.error ?? "Invalid Google Drive folder URL.");
        return;
      }
    }

    try {
      setSubmitting(true);
      // Run pre-creation check if not checked yet
      if (duplicateMatches === null) {
        const dupRes = await checkRecordDuplicates({
          data: {
            firstName,
            lastName,
            personalEmail,
            organizationEmail,
            phoneNumber,
          },
        });
        if (dupRes.matches.length > 0) {
          setDuplicateMatches(dupRes.matches);
          toast.warning(
            "Potential duplicates found. Review the matches above, then click Save Record again if you still wish to proceed.",
          );
          setSubmitting(false);
          return;
        }
      }

      const res = await createEmployeeRecord({
        data: {
          firstName: firstName.trim(),
          lastName: lastName.trim() || null,
          personalEmail: personalEmail.trim() || null,
          organizationEmail: organizationEmail.trim() || null,
          phoneNumber: phoneNumber.trim() || null,
          address: address.trim() || null,
          joiningDate: joiningDate || null,
          lastWorkingDate: lastWorkingDate || null,
          employmentCategory,
          workType,
          departmentId: departmentId || null,
          designation: designation.trim() || null,
          employmentStatus,
          driveFolderUrl: driveFolderUrl.trim() || null,
          notes: notes.trim() || null,
        },
      });
      toast.success(`Historical record ${res.historicalRecordCode} created.`);
      resetForm();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(describeUnknownError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <UserPlus className="size-4 text-red-600" />
            Add Historical Employee Record
          </DialogTitle>
          <DialogDescription className="text-xs">
            Create an archival master record with a unique <code className="font-mono">TAS-REC-XXXX</code> identifier.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-200 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <Info className="size-4 shrink-0 mt-0.5 text-amber-600" />
          <div>
            Adding a historical record does <strong>not</strong> create a login account, assign a{" "}
            <code className="font-mono">TAS-XXX</code> ID, or send setup emails. To onboard an active employee with portal access, use{" "}
            <Link to="/invitations" className="underline font-semibold text-red-700 dark:text-red-400">
              Employee Onboarding
            </Link>
            .
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">First Name *</Label>
              <Input
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value);
                  setDuplicateMatches(null);
                }}
                placeholder="e.g. Vattikonda"
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Last Name</Label>
              <Input
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  setDuplicateMatches(null);
                }}
                placeholder="Optional if unknown"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Personal Email</Label>
              <Input
                type="email"
                value={personalEmail}
                onChange={(e) => {
                  setPersonalEmail(e.target.value);
                  setDuplicateMatches(null);
                }}
                placeholder="name@gmail.com"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Organization Email (TAS Mail)</Label>
              <Input
                type="email"
                value={organizationEmail}
                onChange={(e) => {
                  setOrganizationEmail(e.target.value);
                  setDuplicateMatches(null);
                }}
                placeholder="name@theaischool.co"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Phone Number</Label>
              <Input
                value={phoneNumber}
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  setDuplicateMatches(null);
                }}
                placeholder="+91 98765 43210"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Employment Status</Label>
              <select
                value={employmentStatus}
                onChange={(e) => setEmploymentStatus(e.target.value as "active" | "inactive")}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="inactive">Inactive / Former</option>
                <option value="active">Active</option>
              </select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Joining Date (DOJ)</Label>
              <Input
                type="date"
                value={joiningDate}
                onChange={(e) => setJoiningDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Last Working Date (LWD)</Label>
              <Input
                type="date"
                value={lastWorkingDate}
                onChange={(e) => setLastWorkingDate(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Employment Category</Label>
              <select
                value={employmentCategory}
                onChange={(e) =>
                  setEmploymentCategory(e.target.value as RecordEmploymentCategory)
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {RECORD_EMPLOYMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {RECORD_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Work Type</Label>
              <select
                value={workType}
                onChange={(e) => setWorkType(e.target.value as RecordWorkType)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {RECORD_WORK_TYPES.map((w) => (
                  <option key={w} value={w}>
                    {RECORD_WORK_TYPE_LABELS[w]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Department</Label>
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="">Unknown / Unassigned</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Designation</Label>
              <Input
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                placeholder="e.g. AI Data Annotation Analyst"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Residential Address</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Optional historical address"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <FolderKanban className="size-3.5 text-muted-foreground" />
              Google Drive Employee Folder URL (Main Folder Only)
            </Label>
            <Input
              value={driveFolderUrl}
              onChange={(e) => setDriveFolderUrl(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/..."
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">HR Notes</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Archival context or verification notes..."
            />
          </div>

          {/* Duplicate Check Panel */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                Duplicate Identity Pre-Check
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={runDuplicateCheck}
                disabled={checkingDuplicates}
                className="h-7 text-xs"
              >
                <Search className="mr-1.5 size-3" />
                {checkingDuplicates ? "Checking..." : "Check Duplicates"}
              </Button>
            </div>

            {duplicateMatches && duplicateMatches.length === 0 ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5" /> No conflicts found in Records or Workforce.
              </p>
            ) : duplicateMatches && duplicateMatches.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5" />
                  {duplicateMatches.length} possible duplicate match(es) detected:
                </p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {duplicateMatches.map((m) => (
                    <div
                      key={`${m.source}-${m.id}`}
                      className="rounded border border-amber-200 bg-background px-2.5 py-1.5 text-xs flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className="font-semibold">{m.displayName}</span>{" "}
                        <Badge variant="outline" className="text-[10px] ml-1">
                          {m.source === "workforce" ? "Workforce" : "Records"} {m.code ?? ""}
                        </Badge>
                        <div className="text-[11px] text-muted-foreground">
                          {m.organizationEmail || m.personalEmail || m.phoneNumber || "No contact"}
                        </div>
                      </div>
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">
                        {m.reason}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="bg-zinc-900 hover:bg-zinc-800 text-white"
            >
              {submitting ? "Saving..." : "Save Historical Record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
