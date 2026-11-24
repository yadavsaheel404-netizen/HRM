import { describe, expect, it, vi } from "vitest";
import { buildRoleNavigation, isNavItemActive } from "../navigation";
import {
  canAccessCandidateRecord,
  canSubmitInterviewFeedback,
  normalizeEffectivePermissions,
  type Actor,
  type AppRole,
} from "../permissions";
import {
  applyCandidateColumnMapping,
  autoDetectCandidateColumns,
  summariseCandidateImport,
  validateCandidateImport,
  type CandidateImportLookups,
} from "../recruitment/candidate-import";
import {
  buildEmailIdempotencyKey,
  DEFAULT_EMAIL_TEMPLATES,
  renderEmailTemplate,
  SAMPLE_EMAIL_VARIABLES,
  SUPPORTED_EMAIL_VARIABLES,
  validateTemplateVariables,
} from "../recruitment/email-templates";
import {
  createHostingerSmtpTransport,
  inspectEmailProviderConfig,
  resolveStatusFromProviderEvent,
} from "../recruitment/email-transport.server";
import {
  calculateRecruitmentKpis,
  canConvertCandidateToEmployee,
  createEmptyRecruitmentKpis,
  formatInterviewIstSlot,
  validateCandidateTransition,
} from "../recruitment/pipeline";

function makeActor(roles: AppRole[], rawPerms: string[] = []): Actor {
  return {
    userId: `actor-${roles.join("-")}`,
    fullName: "Test Actor",
    workEmail: "actor@theaischool.in",
    accountStatus: "active",
    category: "full_time",
    roles,
    permissions: normalizeEffectivePermissions(roles, rawPerms),
  };
}

describe("Phase P2 — Candidate CSV/Excel Import, Column Mapping & Duplicate Detection", () => {
  it("auto-detects common HR spreadsheet headers and supports custom column overrides", () => {
    const headers = [
      "Candidate Name",
      "Email Address",
      "Mobile",
      "Team",
      "Job Title",
      "Employment Type",
      "Years of Experience",
      "Earliest Joining",
    ];
    const detected = autoDetectCandidateColumns(headers);
    expect(detected["Full Name"]).toBe("Candidate Name");
    expect(detected["Email"]).toBe("Email Address");
    expect(detected["Phone"]).toBe("Mobile");
    expect(detected["Department"]).toBe("Team");
    expect(detected["Designation"]).toBe("Job Title");
    expect(detected["Category"]).toBe("Employment Type");
    expect(detected["Experience Years"]).toBe("Years of Experience");
    expect(detected["Available Joining Date"]).toBe("Earliest Joining");

    const grid = [
      ["ApplicantCol", "MailCol", "CustomRoleCol"],
      ["Riya Sharma", "riya.sharma@example.com", "AI Curriculum Lead"],
    ];
    const mapped = applyCandidateColumnMapping(grid, {
      "Full Name": "ApplicantCol",
      Email: "MailCol",
      Designation: "CustomRoleCol",
    });
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]?.["Full Name"]).toBe("Riya Sharma");
    expect(mapped.rows[0]?.["Email"]).toBe("riya.sharma@example.com");
    expect(mapped.rows[0]?.["Designation"]).toBe("AI Curriculum Lead");
  });

  it("detects intra-file, candidate, workforce, and invitation duplicates plus invalid rows for partial import", () => {
    const lookups: CandidateImportLookups = {
      departmentsByName: new Map([["operations", "dept-ops-1"]]),
      existingCandidateEmails: new Set(["existing.cand@example.com"]),
      existingEmployeeEmails: new Set(["staff.member@theaischool.in"]),
      pendingInvitationEmails: new Set(["invited.hire@theaischool.in"]),
    };

    const grid = [
      [
        "Full Name",
        "Email",
        "Department",
        "Designation",
        "Category",
        "Experience Years",
        "Available Joining Date",
        "Skills",
      ],
      [
        "Valid Candidate",
        "valid.one@example.com",
        "Operations",
        "AI Trainer",
        "trainer",
        "3.5",
        "2026-12-10",
        "Python, Prompting",
      ],
      [
        "Warning Candidate",
        "warn.two@example.com",
        "Unknown Dept",
        "",
        "intern",
        "0",
        "",
        "",
      ],
      ["Dup File A", "dup@example.com", "Operations", "Dev", "full_time", "2", "", ""],
      ["Dup File B", "DUP@example.com", "Operations", "Dev", "full_time", "2", "", ""],
      [
        "Existing Candidate",
        "existing.cand@example.com",
        "Operations",
        "Dev",
        "full_time",
        "2",
        "",
        "",
      ],
      [
        "Existing Staff",
        "staff.member@theaischool.in",
        "Operations",
        "Dev",
        "full_time",
        "4",
        "",
        "",
      ],
      [
        "Pending Invite",
        "invited.hire@theaischool.in",
        "Operations",
        "Dev",
        "full_time",
        "1",
        "",
        "",
      ],
      [
        "X",
        "not-an-email",
        "Operations",
        "Dev",
        "bad_category",
        "-5",
        "not-a-date",
        "",
      ],
    ];

    const { rows } = applyCandidateColumnMapping(grid);
    const validated = validateCandidateImport(rows, lookups);
    const summary = summariseCandidateImport(validated);

    expect(summary.total).toBe(8);
    expect(summary.valid).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.duplicate).toBe(5);
    expect(summary.invalid).toBe(1);
    expect(summary.importable).toBe(2); // Partial import commits valid + warning rows safely

    expect(validated[0]?.departmentId).toBe("dept-ops-1");
    expect(validated[0]?.appliedCategory).toBe("trainer");
    expect(validated[0]?.skills).toEqual(["Python", "Prompting"]);

    expect(validated[2]?.duplicateSource).toBe("file");
    expect(validated[4]?.duplicateSource).toBe("candidates");
    expect(validated[5]?.duplicateSource).toBe("workforce");
    expect(validated[6]?.duplicateSource).toBe("invitations");
    expect(validated[7]?.severity).toBe("error");
    expect(validated[7]?.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Phase P2 — Candidate Pipeline Transitions, KPIs & Employee Conversion", () => {
  it("enforces valid pipeline stage transitions and blocks bypassing conversion into onboarding", () => {
    expect(
      validateCandidateTransition({ fromStatus: "applied", toStatus: "shortlisted" }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({
        fromStatus: "shortlisted",
        toStatus: "interview_scheduled",
      }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({ fromStatus: "interviewed", toStatus: "selected" }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({ fromStatus: "selected", toStatus: "offer_sent" }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({
        fromStatus: "offer_sent",
        toStatus: "offer_accepted",
      }).ok,
    ).toBe(true);

    // Side statuses supported from active stages
    expect(
      validateCandidateTransition({ fromStatus: "screening", toStatus: "rejected" }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({
        fromStatus: "interview_scheduled",
        toStatus: "on_hold",
      }).ok,
    ).toBe(true);
    expect(
      validateCandidateTransition({ fromStatus: "offer_sent", toStatus: "withdrawn" }).ok,
    ).toBe(true);

    // Direct jump to `onboarding` without conversion is blocked
    const directOnboarding = validateCandidateTransition({
      fromStatus: "offer_accepted",
      toStatus: "onboarding",
    });
    expect(directOnboarding.ok).toBe(false);

    // Allowed when invoked via Candidate-to-Employee conversion flow
    const viaConversion = validateCandidateTransition({
      fromStatus: "offer_accepted",
      toStatus: "onboarding",
      viaConversion: true,
    });
    expect(viaConversion.ok).toBe(true);

    // Converted onboarding candidates cannot be mutated back arbitrarily
    expect(
      validateCandidateTransition({
        fromStatus: "onboarding",
        toStatus: "rejected",
        alreadyConverted: true,
      }).ok,
    ).toBe(false);
  });

  it("computes all 8 HR Recruitment KPIs accurately from real candidate & interview records", () => {
    expect(createEmptyRecruitmentKpis().conversionRatePct).toBe(0);

    const kpis = calculateRecruitmentKpis(
      [
        { status: "applied" },
        { status: "applied" },
        { status: "screening" },
        { status: "shortlisted" },
        { status: "interview_scheduled" },
        { status: "selected" },
        { status: "offer_sent" },
        { status: "offer_accepted", converted_user_id: null },
        { status: "onboarding", converted_user_id: null },
        { status: "onboarding", converted_user_id: "user-converted-1" },
      ],
      4,
    );

    expect(kpis.totalCandidates).toBe(10);
    expect(kpis.newApplications).toBe(2);
    expect(kpis.shortlistedCandidates).toBe(1);
    expect(kpis.interviewsScheduled).toBe(4);
    expect(kpis.selectedCandidates).toBe(1);
    expect(kpis.offersSent).toBe(2); // offer_sent (1) + offer_accepted (1)
    expect(kpis.pendingOnboarding).toBe(2); // offer_accepted + unconverted onboarding
    expect(kpis.conversionRatePct).toBe(50); // 5 positive outcomes / 10 total = 50%
  });

  it("enforces eligibility & duplicate-account guards during Candidate-to-Employee conversion", () => {
    const lookups = {
      existingWorkEmails: new Set(["existing@theaischool.in"]),
      activeInvitationEmails: new Set(["pending@theaischool.in"]),
    };

    // Selected and Offer Accepted are eligible
    expect(
      canConvertCandidateToEmployee(
        {
          email: "New.Hire@theaischool.in",
          fullName: "New Hire",
          status: "selected",
        },
        lookups,
      ),
    ).toEqual({ ok: true, normalizedEmail: "new.hire@theaischool.in" });

    expect(
      canConvertCandidateToEmployee(
        {
          email: "accepted@theaischool.in",
          fullName: "Accepted Hire",
          status: "offer_accepted",
        },
        lookups,
      ).ok,
    ).toBe(true);

    // Non-selected stages rejected
    expect(
      canConvertCandidateToEmployee(
        { email: "early@theaischool.in", fullName: "Early", status: "shortlisted" },
        lookups,
      ).ok,
    ).toBe(false);

    // Already converted candidate rejected
    expect(
      canConvertCandidateToEmployee(
        {
          email: "done@theaischool.in",
          fullName: "Done",
          status: "offer_accepted",
          convertedInvitationId: "inv-123",
        },
        lookups,
      ).ok,
    ).toBe(false);

    // Duplicate employee work_email blocked
    expect(
      canConvertCandidateToEmployee(
        {
          email: "EXISTING@theaischool.in",
          fullName: "Existing",
          status: "offer_accepted",
        },
        lookups,
      ).ok,
    ).toBe(false);

    // Duplicate active invitation blocked
    expect(
      canConvertCandidateToEmployee(
        {
          email: "pending@theaischool.in",
          fullName: "Pending",
          status: "selected",
        },
        lookups,
      ).ok,
    ).toBe(false);
  });
});

describe("Phase P2 — 7-Role Recruitment, Interview & Email Permissions + Navigation", () => {
  it("grants full recruitment, interview, and email control to Super Admin and HR with exact HR nav flow", () => {
    const sa = makeActor(["super_admin"]);
    const hr = makeActor(["hr"], ["invitations:read:all", "workforce:read:all", "requests:read:all"]);

    for (const actor of [sa, hr]) {
      expect(actor.permissions).toContain("recruitment:read:all");
      expect(actor.permissions).toContain("recruitment:manage:all");
      expect(actor.permissions).toContain("interviews:read:all");
      expect(actor.permissions).toContain("interviews:manage:all");
      expect(actor.permissions).toContain("emails:read:all");
      expect(actor.permissions).toContain("emails:manage:all");
      expect(actor.permissions).toContain("emails:send:all");
    }

    // Verify HR primary flow: HR Dashboard -> Candidates -> Interviews -> Email Center -> Onboarding -> Workforce
    const hrGroups = buildRoleNavigation(hr);
    const primaryHrGroup = hrGroups.find((g) => g.id === "people")!;
    expect(primaryHrGroup.items.slice(0, 6).map((i) => i.label)).toEqual([
      "HR Dashboard",
      "Candidates",
      "Interviews",
      "Email Center",
      "Onboarding",
      "Workforce",
    ]);

    // Super Admin hub highlights across all 3 recruitment routes
    const saAllItems = buildRoleNavigation(sa).flatMap((g) => g.items);
    const saRecruitHub = saAllItems.find((i) => i.to === "/candidates")!;
    expect(isNavItemActive("/candidates", saRecruitHub)).toBe(true);
    expect(isNavItemActive("/interviews", saRecruitHub)).toBe(true);
    expect(isNavItemActive("/email-center", saRecruitHub)).toBe(true);
  });

  it("enforces strict read-only recruitment, interview & email visibility on Founder and Admin", () => {
    const founder = makeActor(
      ["founder"],
      ["recruitment:manage:all", "interviews:manage:all", "emails:send:all"],
    );
    const admin = makeActor(
      ["admin"],
      ["recruitment:manage:all", "emails:manage:all", "emails:send:all"],
    );

    for (const actor of [founder, admin]) {
      expect(actor.permissions).toContain("recruitment:read:all");
      expect(actor.permissions).toContain("interviews:read:all");
      expect(actor.permissions).toContain("emails:read:all");

      expect(actor.permissions).not.toContain("recruitment:manage:all");
      expect(actor.permissions).not.toContain("interviews:manage:all");
      expect(actor.permissions).not.toContain("emails:manage:all");
      expect(actor.permissions).not.toContain("emails:send:all");
    }

    // Neither Founder nor Admin can submit interview scorecards unless HR/assigned
    expect(
      canSubmitInterviewFeedback(founder.userId, founder.permissions, [founder.userId]),
    ).toBe(false);
  });

  it("isolates Manager and Lead strictly to assigned interviews and candidates, blocking unassigned records & Email Center", () => {
    const manager = makeActor(["manager"], ["recruitment:read:all", "emails:read:all"]);
    const lead = makeActor(["lead"], []);

    for (const sup of [manager, lead]) {
      expect(sup.permissions).toContain("interviews:feedback:assigned");
      expect(sup.permissions).not.toContain("recruitment:read:all");
      expect(sup.permissions).not.toContain("interviews:read:all");
      expect(sup.permissions).not.toContain("interviews:manage:all");
      expect(sup.permissions).not.toContain("emails:read:all");
      expect(sup.permissions).not.toContain("emails:send:all");

      // Can access candidate & submit scorecard ONLY when assigned on `interviewer_ids`
      expect(
        canAccessCandidateRecord(sup.userId, sup.permissions, [sup.userId, "other-id"]),
      ).toBe(true);
      expect(
        canAccessCandidateRecord(sup.userId, sup.permissions, ["other-id"]),
      ).toBe(false);

      expect(
        canSubmitInterviewFeedback(sup.userId, sup.permissions, [sup.userId]),
      ).toBe(true);
      expect(
        canSubmitInterviewFeedback(sup.userId, sup.permissions, ["someone-else"]),
      ).toBe(false);

      // Navigation includes `/interviews` (Assigned Interviews) and excludes `/candidates` & `/email-center`
      const navPaths = buildRoleNavigation(sup).flatMap((g) => g.items.map((i) => i.to));
      expect(navPaths).toContain("/interviews");
      expect(navPaths).not.toContain("/candidates");
      expect(navPaths).not.toContain("/email-center");
    }
  });

  it("grants Employee zero recruitment, interview, or email permissions and zero recruitment nav items", () => {
    const emp = makeActor(["employee"], ["attendance:log:self", "requests:read:self"]);
    expect(emp.permissions).not.toContain("recruitment:read:all");
    expect(emp.permissions).not.toContain("interviews:feedback:assigned");
    expect(emp.permissions).not.toContain("emails:read:all");
    expect(canAccessCandidateRecord(emp.userId, emp.permissions, [emp.userId])).toBe(
      false,
    );
    expect(canSubmitInterviewFeedback(emp.userId, emp.permissions, [emp.userId])).toBe(
      false,
    );

    const empPaths = buildRoleNavigation(emp).flatMap((g) => g.items.map((i) => i.to));
    expect(empPaths).not.toContain("/candidates");
    expect(empPaths).not.toContain("/interviews");
    expect(empPaths).not.toContain("/email-center");
  });

  it("formats UTC interview timestamps accurately into Asia/Kolkata (IST)", () => {
    // 2026-11-18T09:30:00Z == 18 Nov 2026, 03:00 PM IST
    const slot = formatInterviewIstSlot(
      "2026-11-18T09:30:00.000Z",
      "2026-11-18T10:15:00.000Z",
    );
    expect(slot.dateLabel).toContain("2026");
    expect(slot.timeRangeLabel).toMatch(/03:00.*03:45.*IST/i);
  });
});

describe("Phase P2 — HR Email Template Center (15 Templates, Variables & XSS Safety)", () => {
  it("provides all 15 required standard HR recruitment & communication templates with valid supported variables", () => {
    const expectedSlugs = [
      "application_received",
      "candidate_shortlisted",
      "interview_invitation",
      "interview_rescheduled",
      "interview_reminder",
      "candidate_rejection",
      "candidate_selection",
      "offer_letter",
      "offer_acceptance",
      "onboarding_invitation",
      "document_reminder",
      "employee_welcome",
      "document_correction_request",
      "hr_announcement",
      "work_notice",
      "employee_relieving_letter",
    ];

    expect(DEFAULT_EMAIL_TEMPLATES.map((t) => t.slug)).toEqual(expectedSlugs);

    for (const tpl of DEFAULT_EMAIL_TEMPLATES) {
      const validation = validateTemplateVariables({
        subjectTemplate: tpl.subjectTemplate,
        bodyHtmlTemplate: tpl.bodyHtmlTemplate,
        bodyTextTemplate: tpl.bodyTextTemplate,
      });
      expect(validation.valid).toBe(true);
      expect(validation.unknownVariables).toEqual([]);

      const rendered = renderEmailTemplate({
        subjectTemplate: tpl.subjectTemplate,
        bodyHtmlTemplate: tpl.bodyHtmlTemplate,
        bodyTextTemplate: tpl.bodyTextTemplate,
        variables: SAMPLE_EMAIL_VARIABLES,
      });
      expect(rendered.ok).toBe(true);
      expect(rendered.missingVariables).toEqual([]);
      expect(rendered.bodyHtml).toContain("/the-ai-school-logo.png");
      expect(rendered.bodyHtml).toContain('alt="The AI School"');
    }

    // Confirm all 9 core prompt variables are supported
    for (const reqVar of [
      "candidate_name",
      "designation",
      "department",
      "interview_date",
      "interview_time",
      "meeting_link",
      "hr_contact",
      "joining_date",
      "employee_id",
    ]) {
      expect(SUPPORTED_EMAIL_VARIABLES).toContain(reqVar);
    }
  });

  it("flags unsupported variables, reports missing values, escapes HTML XSS, and generates deterministic idempotency keys", () => {
    const invalidCheck = validateTemplateVariables({
      subjectTemplate: "Hello {{candidate_name}}",
      bodyHtmlTemplate: "<p>Secret token: {{unapproved_secret_var}}</p>",
    });
    expect(invalidCheck.valid).toBe(false);
    expect(invalidCheck.unknownVariables).toEqual(["unapproved_secret_var"]);

    const xssRender = renderEmailTemplate({
      subjectTemplate: "Invite for {{candidate_name}}",
      bodyHtmlTemplate: "<p>Welcome {{candidate_name}} — Role: {{designation}}</p>",
      variables: {
        candidate_name: "<script>alert('xss')</script>",
        designation: "",
      },
    });
    expect(xssRender.ok).toBe(false);
    expect(xssRender.missingVariables).toEqual(["designation"]);
    expect(xssRender.bodyHtml).not.toContain("<script>");
    expect(xssRender.bodyHtml).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");

    const keyA = buildEmailIdempotencyKey({
      templateSlug: "offer_letter",
      recipientEmail: "Ananya@Example.com ",
      candidateId: "cand-1",
      subject: "Offer of Engagement",
      dedupeToken: "2026-11-18T10",
    });
    const keyB = buildEmailIdempotencyKey({
      templateSlug: "offer_letter",
      recipientEmail: "ananya@example.com",
      candidateId: "cand-1",
      subject: "Offer of Engagement",
      dedupeToken: "2026-11-18T10",
    });
    expect(keyA).toBe(keyB);
  });
});

describe("Phase P2 — Hostinger SMTP Readiness, Honest Delivery Status & Zero Live Emails in Tests", () => {
  it("verifies sender configuration strictly and never exposes SMTP password", () => {
    expect(inspectEmailProviderConfig({}).configured).toBe(false);

    // Rejects Titan/Resend providers and personal Gmail logins
    const badCfg = inspectEmailProviderConfig({
      SMTP_HOST: "smtp.titan.email",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "manaswini@gmail.com",
      SMTP_PASS: "SuperSecretMailboxPass123",
      EMAIL_FROM: "manaswini@gmail.com",
    });
    expect(badCfg.configured).toBe(false);
    expect(JSON.stringify(badCfg)).not.toContain("SuperSecretMailboxPass123");

    // Accepts valid Hostinger SMTP config
    const validCfg = inspectEmailProviderConfig({
      SMTP_HOST: "smtp.hostinger.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "hr@theaischool.co",
      SMTP_PASS: "SuperSecretMailboxPass123",
      EMAIL_FROM: "hr@theaischool.co",
      EMAIL_FROM_NAME: "The AI School HR",
    });
    expect(validCfg.configured).toBe(true);
    expect(validCfg.senderDisplay).toBe("The AI School HR <hr@theaischool.co>");
    expect(JSON.stringify(validCfg)).not.toContain("SuperSecretMailboxPass123");
  });

  it("blocks live email dispatches automatically in Vitest unless explicit mock transporter is injected", async () => {
    const sendMailSpy = vi.fn();
    const transport = createHostingerSmtpTransport({
      env: {
        VITEST: "true",
        SMTP_HOST: "smtp.hostinger.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "hr@theaischool.co",
        SMTP_PASS: "SuperSecretMailboxPass123",
        EMAIL_FROM: "hr@theaischool.co",
      },
      transporterFactory: () => ({ sendMail: sendMailSpy }),
    });

    const blocked = await transport.send({
      to: "candidate@example.com",
      subject: "Should Not Send Live",
      html: "<p>Test</p>",
      idempotencyKey: "test-block-1",
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe("failed");
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("records synchronous SMTP 250 acceptance as 'accepted_by_smtp' (NEVER 'delivered')", async () => {
    const mockSendMailOk = vi.fn().mockResolvedValue({
      messageId: "<smtp-msg-998877@theaischool.co>",
      response: "250 2.0.0 Ok: queued as 998877",
      accepted: ["candidate@example.com"],
      rejected: [],
    });

    const transport = createHostingerSmtpTransport({
      env: {
        SMTP_HOST: "smtp.hostinger.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "hr@theaischool.co",
        SMTP_PASS: "MockSecretPass999",
        EMAIL_FROM: "hr@theaischool.co",
      },
      transporterFactory: () => ({ sendMail: mockSendMailOk }),
      allowInTests: true,
    });

    const sentRes = await transport.send({
      to: "candidate@example.com",
      subject: "Interview Invitation",
      html: "<p>Hello</p>",
      text: "Hello",
      idempotencyKey: "idem-iv-1",
    });

    expect(mockSendMailOk).toHaveBeenCalledTimes(1);
    expect(sentRes).toEqual({
      ok: true,
      status: "accepted_by_smtp",
      provider: "hostinger_smtp",
      providerMessageId: "<smtp-msg-998877@theaischool.co>",
      smtpResponse: "250 2.0.0 Ok: queued as 998877",
      attemptsUsed: 1,
    });
    // Explicitly prove synchronous SMTP acceptance is NEVER "delivered"
    expect(sentRes.status).not.toBe("delivered");

    // SMTP rejection -> honest "failed" status
    const mockSendMailFail = vi.fn().mockRejectedValue(
      Object.assign(new Error("Invalid login: 535 5.7.8 Authentication failed"), {
        code: "EAUTH",
        responseCode: 535,
      }),
    );
    const failingTransport = createHostingerSmtpTransport({
      env: {
        SMTP_HOST: "smtp.hostinger.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "hr@theaischool.co",
        SMTP_PASS: "MockSecretPass999",
        EMAIL_FROM: "hr@theaischool.co",
      },
      transporterFactory: () => ({ sendMail: mockSendMailFail }),
      allowInTests: true,
      retryBaseDelayMs: 0,
    });

    const failRes = await failingTransport.send({
      to: "candidate@example.com",
      subject: "Offer Letter",
      html: "<p>Offer</p>",
      idempotencyKey: "idem-offer-1",
    });
    expect(failRes.ok).toBe(false);
    expect(failRes.status).toBe("failed");
    if (!failRes.ok) {
      expect(failRes.errorMessage).toContain("535");
      expect(failRes.errorMessage).not.toContain("MockSecretPass999");
    }

    // Delivery event mapping preserves legacy "sent", adds "accepted_by_smtp" & "canceled"
    expect(resolveStatusFromProviderEvent("smtp.accepted")).toEqual({
      status: "accepted_by_smtp",
    });
    expect(resolveStatusFromProviderEvent("email.sent")).toEqual({ status: "sent" });
    expect(resolveStatusFromProviderEvent("email.delivered")).toEqual({
      status: "delivered",
    });
    expect(resolveStatusFromProviderEvent("email.canceled")).toEqual({
      status: "canceled",
    });
    expect(resolveStatusFromProviderEvent("email.bounced")?.status).toBe("failed");
  });
});

