import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Award,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileCheck,
  FileText,
  Filter,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  UserCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { errorToAccessScreen } from "@/components/access-denied";
import { actorQueryOptions, useActor } from "@/hooks/use-actor";
import {
  approveRelievingCase,
  finalizeAndRelieveEmployee,
  listRelievingCases,
  previewRelievingLetter,
  saveRelievingCase,
  searchRelievingEligibleEmployees,
  sendRelievingLetterEmail,
} from "@/lib/relieving.functions";
import type { RelievingCase } from "@/lib/relieving/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export const Route = createFileRoute("/_authenticated/employee-relieving")({
  head: () => ({
    meta: [
      { title: "Employee Relieving & Experience Letters | The AI School HRM" },
      {
        name: "description",
        content:
          "Manage employee exit clearances, formal relieving approvals, experience letters and Hostinger email delivery.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(actorQueryOptions),
  component: EmployeeRelievingPage,
  errorComponent: ({ error }) => errorToAccessScreen(error),
});

function EmployeeRelievingPage() {
  const actor = useActor();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Dialog states
  const [isInitiateOpen, setIsInitiateOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
  const [previewCaseName, setPreviewCaseName] = useState<string>("");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Form states
  const [selectedEmployee, setSelectedEmployee] = useState<any | null>(null);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [employeeSearchQuery, setEmployeeSearchQuery] = useState("");

  const [formData, setFormData] = useState({
    legalEmployer: "Learning Paths Technologies LLP",
    designation: "",
    joiningDate: "",
    lastWorkingDay: new Date().toISOString().slice(0, 10),
    relievingEffectiveDate: new Date().toISOString().slice(0, 10),
    letterIssueDate: new Date().toISOString().slice(0, 10),
    relievingReason: "Tenure completion",
    contributedProjects: "AI Data Associate Intern and related projects",
    performanceStatement: "satisfactory",
    signatoryName: "K. Spandana",
    signatoryTitle: "Director",
    signatoryDesignation: "Director",
    companyContact: "+91 92468 18843",
    companyAddress: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
    handoverStatus: "completed" as "pending" | "in_progress" | "completed" | "waived",
    projectClearance: true,
    assetClearance: true,
    checklistHandover: true,
    checklistAssets: true,
    checklistAccessRevocation: true,
    checklistDuesCleared: true,
    hrNotes: "",
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Queries
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["relieving-cases", activeTab, searchQuery],
    queryFn: () => listRelievingCases({ data: { tab: activeTab, query: searchQuery } }),
  });

  const { data: eligibleData, isLoading: isLoadingEligible } = useQuery({
    queryKey: ["relieving-eligible-employees", employeeSearchQuery],
    queryFn: () =>
      searchRelievingEligibleEmployees({ data: { query: employeeSearchQuery } }),
    enabled: isInitiateOpen && !selectedEmployee,
  });

  const cases = data?.cases || [];
  const metrics = data?.metrics || {
    total: 0,
    drafts: 0,
    pendingApproval: 0,
    readyToRelieve: 0,
    relieved: 0,
    letterSent: 0,
    needsAttention: 0,
  };
  const canManage = data?.canManage ?? false;
  const canApprove = data?.canApprove ?? false;
  const canSend = data?.canSend ?? false;

  const handleSelectEmployee = (emp: any) => {
    setSelectedEmployee(emp);
    setFormData((prev) => ({
      ...prev,
      designation: emp.designation || "AI Data Associate Intern",
      joiningDate: emp.joiningDate || new Date().toISOString().slice(0, 10),
      contributedProjects: `${emp.designation || "AI Data Associate"} and related projects`,
    }));
  };

  const handleOpenEdit = (c: RelievingCase) => {
    setEditingCaseId(c.id);
    setSelectedEmployee({
      id: c.userId,
      fullName: c.employeeName,
      workEmail: c.workEmail,
      employeeCode: c.employeeCode,
      category: c.employmentCategory,
      designation: c.designation,
      departmentName: c.departmentName,
    });
    setFormData({
      legalEmployer: c.legalEmployer,
      designation: c.designation,
      joiningDate: c.joiningDate,
      lastWorkingDay: c.lastWorkingDay,
      relievingEffectiveDate: c.relievingEffectiveDate,
      letterIssueDate: c.letterIssueDate,
      relievingReason: c.relievingReason,
      contributedProjects: c.contributedProjects,
      performanceStatement: c.performanceStatement,
      signatoryName: c.signatoryName,
      signatoryTitle: c.signatoryTitle,
      signatoryDesignation: c.signatoryDesignation,
      companyContact: c.companyContact,
      companyAddress: c.companyAddress,
      handoverStatus: c.handoverStatus,
      projectClearance: c.projectClearance,
      assetClearance: c.assetClearance,
      checklistHandover: c.checklistHandover,
      checklistAssets: c.checklistAssets,
      checklistAccessRevocation: c.checklistAccessRevocation,
      checklistDuesCleared: c.checklistDuesCleared,
      hrNotes: c.hrNotes || "",
    });
    setIsInitiateOpen(true);
  };

  const handleResetForm = () => {
    setSelectedEmployee(null);
    setEditingCaseId(null);
    setEmployeeSearchQuery("");
    setFormData({
      legalEmployer: "Learning Paths Technologies LLP",
      designation: "",
      joiningDate: "",
      lastWorkingDay: new Date().toISOString().slice(0, 10),
      relievingEffectiveDate: new Date().toISOString().slice(0, 10),
      letterIssueDate: new Date().toISOString().slice(0, 10),
      relievingReason: "Tenure completion",
      contributedProjects: "AI Data Associate Intern and related projects",
      performanceStatement: "satisfactory",
      signatoryName: "K. Spandana",
      signatoryTitle: "Director",
      signatoryDesignation: "Director",
      companyContact: "+91 92468 18843",
      companyAddress: "T-hub 2.0, Knowledge City, Hyderabad, Telangana",
      handoverStatus: "completed",
      projectClearance: true,
      assetClearance: true,
      checklistHandover: true,
      checklistAssets: true,
      checklistAccessRevocation: true,
      checklistDuesCleared: true,
      hrNotes: "",
    });
    setIsInitiateOpen(false);
  };

  const handleSaveCase = async (status: "draft" | "pending_approval") => {
    if (!selectedEmployee) {
      toast.error("Please select an employee.");
      return;
    }
    if (!formData.joiningDate || !formData.lastWorkingDay || !formData.relievingEffectiveDate) {
      toast.error("Joining date, last working day, and relieving date are required.");
      return;
    }

    try {
      setIsSubmitting(true);
      await saveRelievingCase({
        data: {
          id: editingCaseId || undefined,
          userId: selectedEmployee.id,
          status,
          employeeName: selectedEmployee.fullName,
          employeeCode: selectedEmployee.employeeCode || undefined,
          workEmail: selectedEmployee.workEmail,
          designation: formData.designation,
          departmentId: selectedEmployee.departmentId,
          departmentName: selectedEmployee.departmentName,
          employmentCategory: selectedEmployee.category || "intern",
          legalEmployer: formData.legalEmployer,
          joiningDate: formData.joiningDate,
          lastWorkingDay: formData.lastWorkingDay,
          relievingEffectiveDate: formData.relievingEffectiveDate,
          letterIssueDate: formData.letterIssueDate,
          relievingReason: formData.relievingReason,
          contributedProjects: formData.contributedProjects,
          performanceStatement: formData.performanceStatement,
          handoverStatus: formData.handoverStatus,
          projectClearance: formData.projectClearance,
          assetClearance: formData.assetClearance,
          signatoryName: formData.signatoryName,
          signatoryTitle: formData.signatoryTitle,
          signatoryDesignation: formData.signatoryDesignation,
          companyContact: formData.companyContact,
          companyAddress: formData.companyAddress,
          hrNotes: formData.hrNotes,
          checklistHandover: formData.checklistHandover,
          checklistAssets: formData.checklistAssets,
          checklistAccessRevocation: formData.checklistAccessRevocation,
          checklistDuesCleared: formData.checklistDuesCleared,
        },
      });

      toast.success(
        status === "pending_approval"
          ? "Case submitted for approval."
          : "Case saved as draft."
      );
      handleResetForm();
      queryClient.invalidateQueries({ queryKey: ["relieving-cases"] });
    } catch (err: any) {
      toast.error(err.message || "Failed to save relieving case.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApprove = async (caseId: string) => {
    try {
      setActionLoadingId(caseId);
      await approveRelievingCase({ data: { id: caseId } });
      toast.success("Relieving case approved.");
      queryClient.invalidateQueries({ queryKey: ["relieving-cases"] });
    } catch (err: any) {
      toast.error(err.message || "Approval failed.");
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleFinalizeRelieving = async (caseId: string, employeeName: string) => {
    if (
      !confirm(
        `Are you sure you want to formally relieve ${employeeName}? This will finalize the official letter and update their employment status to Relieved while preserving all records.`
      )
    ) {
      return;
    }

    try {
      setActionLoadingId(caseId);
      await finalizeAndRelieveEmployee({ data: { id: caseId } });
      toast.success(`${employeeName} has been formally relieved.`);
      queryClient.invalidateQueries({ queryKey: ["relieving-cases"] });
    } catch (err: any) {
      toast.error(err.message || "Relieving finalization failed.");
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleSendEmail = async (caseId: string, employeeName: string) => {
    try {
      setActionLoadingId(caseId);
      await sendRelievingLetterEmail({ data: { id: caseId } });
      toast.success(
        `Experience letter accepted by Hostinger SMTP for delivery to ${employeeName}.`
      );
      queryClient.invalidateQueries({ queryKey: ["relieving-cases"] });
    } catch (err: any) {
      toast.error(err.message || "Email dispatch failed.");
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleOpenPreview = async (c: RelievingCase, isDraft: boolean) => {
    try {
      setIsLoadingPreview(true);
      setPreviewCaseName(c.employeeName);
      const res = await previewRelievingLetter({
        data: { caseId: c.id, isDraft },
      });
      const binaryString = atob(res.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setPreviewPdfUrl((prev) => {
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        return blobUrl;
      });
      setIsPreviewOpen(true);
    } catch (err: any) {
      toast.error(err.message || "Failed to generate preview.");
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleDownloadPdf = (dataUri: string, filename: string) => {
    const link = document.createElement("a");
    link.href = dataUri;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <AppShell
      title="Employee Relieving"
      description="Manage employee exits, final verification, relieving letters and Hostinger email delivery."
      actions={
        canManage ? (
          <Button
            onClick={() => {
              handleResetForm();
              setIsInitiateOpen(true);
            }}
            className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-2 font-medium"
          >
            <Plus className="w-4 h-4" />
            Initiate Relieving
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        {/* Metric Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Total Cases
              </div>
              <div className="text-2xl font-bold text-slate-900 mt-1">
                {metrics.total}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-amber-600 uppercase tracking-wider">
                Pending Approval
              </div>
              <div className="text-2xl font-bold text-amber-700 mt-1">
                {metrics.pendingApproval}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
                Ready to Relieve
              </div>
              <div className="text-2xl font-bold text-blue-700 mt-1">
                {metrics.readyToRelieve}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">
                Relieved
              </div>
              <div className="text-2xl font-bold text-emerald-700 mt-1">
                {metrics.relieved}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">
                Letter Sent
              </div>
              <div className="text-2xl font-bold text-indigo-700 mt-1">
                {metrics.letterSent}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-xs">
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-red-600 uppercase tracking-wider">
                Needs Attention
              </div>
              <div className="text-2xl font-bold text-red-700 mt-1">
                {metrics.needsAttention}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search and Tabs */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 flex-wrap">
            {[
              { id: "all", label: `All (${metrics.total})` },
              { id: "drafts", label: `Drafts (${metrics.drafts})` },
              { id: "pending_approval", label: `Awaiting Approval (${metrics.pendingApproval})` },
              { id: "ready_to_relieve", label: `Ready to Relieve (${metrics.readyToRelieve})` },
              { id: "relieved", label: `Relieved (${metrics.relieved})` },
              { id: "letter_sent", label: `Letter Sent (${metrics.letterSent})` },
              { id: "needs_attention", label: `Needs Attention (${metrics.needsAttention})` },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-slate-900 text-white shadow-xs"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <Input
              placeholder="Search employee, email, code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 text-xs h-9"
            />
          </div>
        </div>

        {/* Table of Relieving Cases */}
        <Card className="border border-slate-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Designation & Dept</th>
                  <th className="py-3 px-4">Tenure & Dates</th>
                  <th className="py-3 px-4">Clearance</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Email Delivery</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-slate-400" />
                      Loading relieving cases...
                    </td>
                  </tr>
                ) : cases.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-slate-400">
                      <FileCheck className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                      <p className="text-base font-medium text-slate-600">No relieving records found</p>
                      <p className="text-xs text-slate-400 mt-1">
                        {canManage
                          ? "Click 'Initiate Relieving' to start the exit workflow for an employee."
                          : "You do not have any relieving records at this time."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  (cases as RelievingCase[]).map((c: RelievingCase) => (
                    <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900">{c.employeeName}</div>
                        <div className="text-xs text-slate-500">{c.workEmail}</div>
                        {c.employeeCode && (
                          <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                            {c.employeeCode}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="text-xs font-medium text-slate-800">{c.designation}</div>
                        <div className="text-xs text-slate-500">
                          {c.departmentName || "General Workforce"}
                        </div>
                        <Badge variant="outline" className="text-[10px] mt-1 uppercase">
                          {c.employmentCategory}
                        </Badge>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600">
                        <div>
                          <span className="text-slate-400">From:</span> {c.joiningDate}
                        </div>
                        <div>
                          <span className="text-slate-400">Last day:</span> {c.lastWorkingDay}
                        </div>
                        <div className="font-medium text-slate-900 mt-0.5">
                          <span className="text-slate-400">Relieved:</span> {c.relievingEffectiveDate}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="space-y-1 text-xs">
                          <div className="flex items-center gap-1.5">
                            {c.checklistHandover ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-amber-500" />
                            )}
                            <span className="text-slate-700">Handover</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {c.checklistAssets ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-amber-500" />
                            )}
                            <span className="text-slate-700">Assets</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {c.status === "draft" && (
                          <Badge className="bg-slate-100 text-slate-700 border-slate-200">
                            Draft
                          </Badge>
                        )}
                        {c.status === "pending_approval" && (
                          <Badge className="bg-amber-50 text-amber-700 border-amber-200">
                            Awaiting Approval
                          </Badge>
                        )}
                        {c.status === "approved" && (
                          <Badge className="bg-blue-50 text-blue-700 border-blue-200">
                            Ready to Relieve
                          </Badge>
                        )}
                        {c.status === "relieved" && (
                          <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                            Relieved
                          </Badge>
                        )}
                        {c.status === "rejected" && (
                          <Badge className="bg-red-50 text-red-700 border-red-200">
                            Rejected
                          </Badge>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {c.emailStatus === "accepted_by_smtp" || c.emailStatus === "delivered" ? (
                          <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                            <CheckCircle2 className="w-4 h-4" />
                            Delivered
                          </div>
                        ) : c.emailStatus === "failed" ? (
                          <div className="flex items-center gap-1 text-xs text-red-600 font-medium">
                            <XCircle className="w-4 h-4" />
                            Failed
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">Not Sent</span>
                        )}
                        {c.emailSentAt && (
                          <div className="text-[10px] text-slate-400">
                            {new Date(c.emailSentAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Live Preview Button */}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenPreview(c, c.status !== "relieved")}
                            className="h-8 px-2 text-slate-600 hover:text-slate-900"
                            title="Preview Letter PDF"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>

                          {/* Edit / View Details */}
                          {canManage && (c.status === "draft" || c.status === "pending_approval") && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleOpenEdit(c)}
                              className="h-8 px-2.5 text-xs"
                            >
                              Edit
                            </Button>
                          )}

                          {/* Approve Action */}
                          {canApprove && c.status === "pending_approval" && (
                            <Button
                              size="sm"
                              onClick={() => handleApprove(c.id)}
                              disabled={actionLoadingId === c.id}
                              className="h-8 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                            >
                              Approve
                            </Button>
                          )}

                          {/* Officially Relieve Action */}
                          {canManage && c.status === "approved" && (
                            <Button
                              size="sm"
                              onClick={() => handleFinalizeRelieving(c.id, c.employeeName)}
                              disabled={actionLoadingId === c.id}
                              className="h-8 px-2.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                            >
                              Relieve
                            </Button>
                          )}

                          {/* Send Email Action */}
                          {canSend && (c.status === "approved" || c.status === "relieved") && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleSendEmail(c.id, c.employeeName)}
                              disabled={actionLoadingId === c.id}
                              className="h-8 px-2.5 text-xs text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                              title="Send Experience Letter via Hostinger SMTP"
                            >
                              <Mail className="w-3.5 h-3.5 text-red-600" />
                              {c.emailStatus === "accepted_by_smtp" ? "Resend" : "Send Letter"}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* INITIATE / EDIT DIALOG */}
      <Dialog open={isInitiateOpen} onOpenChange={setIsInitiateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold text-slate-900">
              {editingCaseId ? "Edit Relieving Details" : "Initiate Employee Relieving"}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              Complete the verification checklist and exact Experience Letter details for the exiting employee.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Step 1: Employee Selection (if new) */}
            {!selectedEmployee ? (
              <div className="space-y-3">
                <Label className="text-xs font-semibold text-slate-700">
                  Select Exiting Employee
                </Label>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <Input
                    placeholder="Search by name, email, employee code..."
                    value={employeeSearchQuery}
                    onChange={(e) => setEmployeeSearchQuery(e.target.value)}
                    className="pl-9 text-xs h-9"
                  />
                </div>

                <div className="border border-slate-200 rounded-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
                  {isLoadingEligible ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      Loading workforce directory...
                    </div>
                  ) : eligibleData?.employees.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      No active workforce employees match your search.
                    </div>
                  ) : (
                    eligibleData?.employees.map((emp) => (
                      <div
                        key={emp.id}
                        onClick={() => handleSelectEmployee(emp)}
                        className="p-3 hover:bg-slate-50 cursor-pointer flex items-center justify-between transition-colors"
                      >
                        <div>
                          <div className="text-xs font-semibold text-slate-900">
                            {emp.fullName}
                          </div>
                          <div className="text-[11px] text-slate-500">{emp.workEmail}</div>
                          <div className="text-[11px] text-slate-400">
                            {emp.designation} • {emp.departmentName || "No Dept"}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          Select
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-900">
                    {selectedEmployee.fullName}
                  </div>
                  <div className="text-xs text-slate-500">
                    {selectedEmployee.workEmail} • {selectedEmployee.designation}
                  </div>
                </div>
                {!editingCaseId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedEmployee(null)}
                    className="h-7 text-xs text-slate-500 hover:text-slate-800"
                  >
                    Change
                  </Button>
                )}
              </div>
            )}

            {/* Step 2: Relieving Letter Fields */}
            {selectedEmployee && (
              <div className="space-y-4">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500 border-b pb-1">
                  Letter Parameters & Experience Details
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Legal Employer Name</Label>
                    <Input
                      value={formData.legalEmployer}
                      onChange={(e) =>
                        setFormData({ ...formData, legalEmployer: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Official Designation</Label>
                    <Input
                      value={formData.designation}
                      onChange={(e) =>
                        setFormData({ ...formData, designation: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Joining Date</Label>
                    <Input
                      type="date"
                      value={formData.joiningDate}
                      onChange={(e) =>
                        setFormData({ ...formData, joiningDate: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Last Working Day</Label>
                    <Input
                      type="date"
                      value={formData.lastWorkingDay}
                      onChange={(e) =>
                        setFormData({ ...formData, lastWorkingDay: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Effective Relieving Date</Label>
                    <Input
                      type="date"
                      value={formData.relievingEffectiveDate}
                      onChange={(e) =>
                        setFormData({ ...formData, relievingEffectiveDate: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">Contributed Projects / Focus Area</Label>
                  <Input
                    placeholder="e.g. AI Data Associate Intern and related projects"
                    value={formData.contributedProjects}
                    onChange={(e) =>
                      setFormData({ ...formData, contributedProjects: e.target.value })
                    }
                    className="text-xs h-9"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Performance Statement</Label>
                    <Input
                      placeholder="satisfactory / exemplary / commendable"
                      value={formData.performanceStatement}
                      onChange={(e) =>
                        setFormData({ ...formData, performanceStatement: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Letter Issue Date</Label>
                    <Input
                      type="date"
                      value={formData.letterIssueDate}
                      onChange={(e) =>
                        setFormData({ ...formData, letterIssueDate: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Authorized Signatory Name</Label>
                    <Input
                      value={formData.signatoryName}
                      onChange={(e) =>
                        setFormData({ ...formData, signatoryName: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Signatory Designation</Label>
                    <Input
                      value={formData.signatoryDesignation}
                      onChange={(e) =>
                        setFormData({ ...formData, signatoryDesignation: e.target.value })
                      }
                      className="text-xs h-9"
                    />
                  </div>
                </div>

                {/* Step 3: Clearance Checklist */}
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500 border-b pb-1 pt-2">
                  Exit & Clearance Checklist
                </div>

                <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="flex items-center gap-2 text-xs cursor-pointer text-slate-700">
                    <input
                      type="checkbox"
                      checked={formData.checklistHandover}
                      onChange={(e) =>
                        setFormData({ ...formData, checklistHandover: e.target.checked })
                      }
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    Handover Completed
                  </label>

                  <label className="flex items-center gap-2 text-xs cursor-pointer text-slate-700">
                    <input
                      type="checkbox"
                      checked={formData.checklistAssets}
                      onChange={(e) =>
                        setFormData({ ...formData, checklistAssets: e.target.checked })
                      }
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    Assets Returned
                  </label>

                  <label className="flex items-center gap-2 text-xs cursor-pointer text-slate-700">
                    <input
                      type="checkbox"
                      checked={formData.checklistAccessRevocation}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          checklistAccessRevocation: e.target.checked,
                        })
                      }
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    System Access Revoked
                  </label>

                  <label className="flex items-center gap-2 text-xs cursor-pointer text-slate-700">
                    <input
                      type="checkbox"
                      checked={formData.checklistDuesCleared}
                      onChange={(e) =>
                        setFormData({ ...formData, checklistDuesCleared: e.target.checked })
                      }
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    Accounts & Dues Cleared
                  </label>
                </div>

                <div>
                  <Label className="text-xs">HR Notes / Internal Remarks (Optional)</Label>
                  <Textarea
                    placeholder="Enter any internal handover or relieving notes..."
                    value={formData.hrNotes}
                    onChange={(e) =>
                      setFormData({ ...formData, hrNotes: e.target.value })
                    }
                    className="text-xs h-16"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={handleResetForm} disabled={isSubmitting}>
              Cancel
            </Button>
            {selectedEmployee && (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleSaveCase("draft")}
                  disabled={isSubmitting}
                  className="text-xs"
                >
                  Save Draft
                </Button>
                <Button
                  onClick={() => handleSaveCase("pending_approval")}
                  disabled={isSubmitting}
                  className="bg-red-600 hover:bg-red-700 text-white text-xs font-medium"
                >
                  Submit for Approval
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LIVE PDF PREVIEW DIALOG */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[95vh] h-[90vh] flex flex-col p-4">
          <DialogHeader className="pb-2 border-b flex-shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-base font-bold text-slate-900">
                  Experience & Relieving Letter — {previewCaseName}
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-500">
                  Exact template rendering with embedded banners and official signature/stamp.
                </DialogDescription>
              </div>
              {previewPdfUrl && (
                <Button
                  size="sm"
                  onClick={() =>
                    handleDownloadPdf(previewPdfUrl, `Experience_Letter_${previewCaseName}.pdf`)
                  }
                  className="bg-slate-900 text-white hover:bg-slate-800 text-xs flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download PDF
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 w-full bg-slate-100 rounded-lg overflow-hidden border border-slate-200 mt-2">
            {isLoadingPreview ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                <RefreshCw className="w-6 h-6 animate-spin mr-2" />
                Generating document preview...
              </div>
            ) : previewPdfUrl ? (
              <iframe
                src={previewPdfUrl}
                title="Relieving Letter Preview"
                className="w-full h-full border-0"
              />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                No preview available.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
