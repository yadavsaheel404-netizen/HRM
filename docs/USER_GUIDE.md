# The AI School HRM Portal — User Guide

A practical manual for everyone who uses the portal. It covers only what is built and working today.

---

## 1. Getting started (everyone)

### 1.1 How your account is created
Accounts are **invitation-only**. Nobody can self-register.

1. HR or an Admin adds you on the **Invitations** screen (or you are pulled in from a legacy import).
2. Your invitation is placed in a queue and sent in small batches, so large joining groups (100+) go out without dropping anyone.
3. You receive an invitation email. Open it and follow the link.
4. Set your password. You are now signed in and land on **Dashboard**.

### 1.2 Account lifecycle
Your status badge appears on **My Profile** and in the **Workforce** directory.

| Status | What it means | What you do |
|---|---|---|
| **Invited** | Invitation sent, you have not opened it yet | Open the invitation email and set a password |
| **Activated** | You logged in for the first time | Go to **My Profile** and start filling in your details |
| **Profile Pending** | Personal/employment details or documents are incomplete | Complete every field and upload all required documents |
| **Under Verification** | You submitted everything; HR is checking it | Wait. HR either verifies you or sends it back with a note |
| **Active** | HR verified you | You can be allocated to projects and log daily work |

Required documents: **Resume**, **Identity Proof**, **PAN**, **Bank Details**, **Educational Documents**. Offer Letter / Contract, NDA and Other are optional or uploaded by HR.

### 1.3 Signing in and forgotten passwords
- Go to `/auth`. Enter your work email and password, then **Sign in**.
- No password handy? Choose **Sign in with an email link instead** and click **Email me a sign-in link** — a one-time link arrives in your inbox. This only works for existing accounts.
- **Continue with Google** works if your work email is a Google account.
- Forgot your password: use the email link to get in, then set a new password from your profile. If your email is not recognised, contact HR — you have not been invited yet.

### 1.4 The sidebar
Everybody sees: **Dashboard**, **My Profile**, **My Day**, **My Assignments**, **Requests**, **Projects**.

Extra items appear only if your role has the matching permission:

| Menu item | Who sees it |
|---|---|
| **Task Reviews** | Leads (and anyone who can review team tasks) |
| **Team Review** | Leads, HR, Admin, Founder, Super Admin |
| **Organisation** | HR, Admin, Founder, Super Admin |
| **Workforce** | Leads (their team), HR, Admin, Super Admin (everyone) |
| **Invitations** | HR, Admin, Super Admin |
| **Automation** | Admin, Super Admin |
| **Legacy Import** | Admin, Super Admin |

The bell icon at the top right shows unread **notifications**.

Menus are not the security boundary — permissions are enforced on the server. If you reach a page you are not allowed to see, you get a clear "not authorised" screen, not a blank page.

---

## 2. Role-by-role guide

## 2.1 EMPLOYEE
Applies to all four categories — **Full-Time**, **Intern**, **Freelancer**, **Trainer**. The screens and steps are identical; the differences are:
- **Full-Time / Intern**: normally have a reporting lead and full daily-cycle expectations.
- **Freelancer / Trainer**: often engaged per project. If no reporting lead is assigned to you, leave/WFH requests are **blocked** (see 3.4) until HR assigns one.
- Daily required hours and unit targets come from the **project** you are allocated to, not from your category.

### Completing your profile
1. Open **My Profile**.
2. Fill in personal details, contact details and employment details, then click **Save details**.
3. Upload each required document in the documents section.
4. When everything is in, your status moves to **Under Verification**. HR then either verifies you (**Active**) or sends it back with a reason — fix the noted items and save again.
5. Once verified, some fields lock; ask HR to change them.

### Viewing and acknowledging an assignment
**You cannot check in or log any work until you acknowledge an assignment.**

1. Open **My Assignments**.
2. Each card shows the project, your allocation percentage, hours per day, your lead and the dates.
3. Read it, optionally type a note, then click **Acknowledge assignment**.
4. The acknowledgement is recorded with a timestamp — it is your record that you accepted the work.

### Checking in
1. Open **My Day**.
2. Choose your **Work mode**: Work from office, Work from home, Hybrid, Client location, Field work.
3. If you are starting late, type a short **Late reason (if applicable)**.
4. Click **Check in**.
5. If you have no acknowledged assignment, the card says work logging is closed and links you to **My assignments**.
6. Late check-ins are recorded with your reason and may be flagged automatically for your lead.

### Logging hourly task entries
1. In **Hourly task entries** on **My Day**, pick the assignment under **Project**.
2. Choose a **Slot type**:
   - **Fixed hourly slot** — one clean clock hour (e.g. 10:00–11:00).
   - **Flexible range** — any start/end you actually worked.
3. Set **Start** and **End**, write what you did, and enter **Units completed**.
4. Click **Add & submit**.
5. Entries cannot overlap each other. If they do, the entry is rejected with a message — adjust the times.
6. Lifecycle: **draft → submitted → approved / revision required**.
   - Draft entries can be submitted (send icon) or deleted (bin icon).
   - Submitted entries wait for your lead.
   - **Approved = locked**: you can no longer edit or delete it. Ask your lead if something must change.
   - **Revision required**: it comes back to you with a note; delete it and re-log correctly.

### Logging a break
1. In the **Breaks** card, pick a category — Lunch, Short break, Meeting, Training, Personal, Other — and start the break.
2. End it when you return. Break time is subtracted from your worked time and shown as **Breaks** in the attendance panel.

### Raising a blocker
1. In the **Blockers** card choose the assignment, a **category** — Data quality, Tooling, Access / permissions, Dependency on someone, Needs guidance, Client-side, Personal, Other — and a **severity** (Low, Medium, High, Critical).
2. Describe the problem and raise it.
3. Your project's reporting lead receives an in-app notification immediately.
4. Blocked time is tracked separately and shown as **Blocked**, so it does not count against you as idle time.
5. Resolve the blocker when it clears.

### Checking out and the EOD report
1. Click **Check out** when your day is done.
2. Open the **End-of-day report** card. Auto-filled from your data: hours attended, task time, break time, blocked time, uncovered minutes, units completed, and target achievement.
3. You write: **What you completed**, **Plan for tomorrow**, **Challenges**, **Support needed**.
4. Submit. If validation fails you will see exactly why — common reasons: you never checked in, you have not checked out, there are draft (unsubmitted) entries, no task entries at all, or too many **uncovered** minutes (time inside your working window not covered by a task, break or blocker).
5. Fix the flagged item and submit again. After the configured cut-off window your day's EOD locks automatically.

### Your attendance status
The badge at the top of **My Day** is derived from your actual timestamps — nobody sets it by hand.

| Label | Plain meaning |
|---|---|
| **Present — Complete** | Checked in and out, hours met, EOD submitted |
| **Present — Hours Incomplete** | You worked, but less than the required hours |
| **Present — EOD Pending** | Day worked, EOD report not submitted yet |
| **Half Day** | Roughly half of the required hours |
| **Missed Check-Out** | Checked in but never checked out |
| **Absent** | No check-in on a working day |
| **On Leave** | Approved leave for that date |
| **Holiday** | Company holiday from the org calendar |
| **Weekly Off** | Your non-working day |
| **Review Required** | Something is inconsistent and a human must look (e.g. corrections pending) |

### Leave / WFH / attendance-correction requests
1. Open **Requests** → **New request**.
2. Pick **Type**: Leave, Work from home, or Attendance correction.
3. Set **From** and **To** dates, write your **Reason**, click **Submit request**.
4. **Employee requests need TWO approvals: your Lead and HR.** Approval by only one keeps the request **Pending** — it is not approved until both have signed off.
5. The **Approval trail** on each request shows who has acted and who is still pending.
6. You can **Cancel** your own request while it is pending.
7. If you have no reporting lead, submission is blocked with a message asking you to contact HR — this is deliberate, so requests never silently skip lead approval.

### Notifications
Click the bell in the top bar for allocation, review, blocker, request and automation alerts. Opening the list clears the unread count.

---

## 2.2 LEAD / PROJECT LEAD
A Lead does everything an Employee does (own profile, own assignment, own My Day, own requests) **plus** the following.

### Team dashboard — **Team Review**
1. Open **Team Review** for a roster of everyone reporting to you, for the selected date.
2. Metrics per person:
   - **Attended** — actual worked time after breaks.
   - **Task time** — time covered by task entries.
   - **Breaks** / **Blocked** — categorised non-task time.
   - **Uncovered** — working time with nothing logged against it. Large values need a conversation.
   - **Units / target** and **achievement %** — real units against the project's per-hour and per-day targets.
   - **Status** — the derived attendance label.
3. Click a person to drill into their entries, breaks, blockers and EOD.
4. **Export CSV** downloads exactly the numbers on screen.

### Reviewing hourly entries
1. Open **Task Reviews** to see everything your team submitted today.
2. For each entry you may set **Approved** and **Rejected** unit counts and add a **Review note**.
3. Click **Approve** (locks the entry for the employee) or **Needs revision** (returns it with your note).

### Reviewing EOD reports
1. On **Team Review**, open the person's EOD report.
2. Choose an action and click **Record action**: **Approve**, **Approve with comment**, **Request revision**, **Escalate**, or **Mark as performance concern**.
3. The employee is notified and the report status updates accordingly.

### Your own leave / WFH request
When **you** submit a request, it routes to **HR only** — a single approver. Leads are not approved by other Leads. Everything else works the same as for employees.

---

## 2.3 HR

### Onboarding one new person
1. Open **Invitations**.
2. Enter their name, work email, category, role, designation and (importantly) their **reporting lead**, then click **Add to queue**.
3. Click **Send queued now** to dispatch immediately, or let the throttled worker send the batch.
4. Track each invitation's status on the same screen: queued → sent → accepted.

### Verifying profiles and documents
1. Open **Workforce**, then the person's record.
2. Review their details and click **Open** on each uploaded document.
3. Click **Verify & activate** to move them to **Active**, or **Send back** with a reason so they can correct and resubmit.

### Approving requests
Open **Requests** → **Approval queue**. Your button is labelled **Approve as HR**.
- **Employee / Lead-reporting staff requests**: you are **one of two** approvers. The request stays **Pending** until the Lead has approved as well, in either order.
- **A Lead's own request**: you are the **sole** approver — your approval completes it.
- You can also reject with a reason at either tier.

### The "unassigned reporting lead" list
- A warning card on **Workforce** (and a counter on the Admin/Org view) lists everyone with no reporting lead.
- It matters because those people **cannot submit leave, WFH or attendance-correction requests** — there is nobody for the lead approval step.
- Click a name, set the reporting lead in their employment details, and they drop off the list automatically.

### What HR should not do
HR does not change project task data, targets or per-hour unit expectations. Those belong to Admin/Super Admin and the project's Lead. HR owns people data: onboarding, verification, employment details and request approvals.

---

## 2.4 ADMIN / SUPER ADMIN

### Creating a project
1. Open **Projects** → the create form.
2. Enter code, client, name, description, **shift** (General/Morning/Evening/Night/Rotational/Flexible), **work mode** (Onsite/Remote/Hybrid), **status** (Draft/Active/On hold/Completed/Archived), **task unit** (task, clip, image, video, audio minute, document, record, annotation, row, other), the **per-hour** and **per-day** targets, and required daily hours.
3. Click **Create project**. Targets drive every achievement percentage the portal later reports.

### Allocating people
1. Open the project → the allocation form.
2. Pick the person, allocation percentage, hours per day, the project lead and the start date, then click **Allocate**.
3. If the person's total allocation across all projects would exceed 100%, an over-allocation warning appears with their current usage. Choose **Cancel** to rethink or **Allocate anyway** to proceed knowingly.
4. Allocations must be acknowledged by the employee before they can log work.
5. Use **End** to close an allocation when the work finishes.

### Roles and the permission matrix
1. Open **Organisation** → the roles/permission section.
2. Assign or remove roles per person (Super Admin, Founder, HR, Admin, Lead, Employee).
3. The matrix shows which permission each role holds. Permissions are checked on the server for every action, so removing a role takes effect immediately.

### Org-wide monitoring
**Organisation** gives, for any date or range:
- **Attendance status mix** — how many people landed in each derived status.
- **Attendance & productivity** — worked time, task time, breaks, blocked, uncovered, units and achievement, viewable org-wide, by project or by individual.
- **Consolidated EOD reports** — every submitted report with its review state.
- The unassigned-reporting-lead warning card.

### Reports
Use the **Export CSV** buttons on **Team Review** and **Organisation**. Exports use the same calculation engine as the screen, so a 104.2% achievement on screen is 104.2% in the file. Open the CSV directly in Excel or Sheets.

### Legacy Excel/CSV import
Open **Legacy Import** and work through the numbered steps.
1. **1 · Upload a workbook** — choose the Excel or CSV file.
2. **2 · Map each sheet to a project** — pick a project per sheet, or **No project**. Then click **Parse and preview**.
3. **3 · Preview** — a grid of Person, Identifier, DOJ / LWD, Cells and Match. The importer converts wide month-columns into per-day rows, handles the messy legacy date headers (including the "22dn" style typo), and maps Present / Remote / Leave / Half day / Week-off into attendance signals.
4. **4 · Manual mapping queue** — rows whose identifier could not be matched to an existing person (numeric IDs, placeholders, ambiguous names). For each row: **Invite as new** (queues an invitation) or **Skip**.
5. **5 · Invite and commit** — **Queue invitations** sends invitations for the rows you marked new; **Commit** writes the attendance and calendar rows.
6. Imported history is stored as historical data and is **never** treated as live activity — automation rules ignore it entirely.
7. People created this way land in **Invited** status and, if no reporting lead was set, appear immediately on the unassigned-reporting-lead list.
Use **Batches** to return to an earlier upload and review or commit it later.

### Automation
Open **Automation** to see the scheduled checks and their thresholds, adjust them with **Save thresholds**, and trigger a run manually. Checks that exist today: no check-in flags, hourly logging reminders, missing/overlapping entry detection, missed check-out flags, low-productivity and high-rejection flags, and the EOD lock after the configured window. Every rule runs only against live data and is protected against double-firing.

### Audit log
**Organisation → Audit trail** lists who did what and when — invitations, imports, verifications, allocations, reviews and approvals — with the actor's email and timestamp.

### Announcements
**Organisation → Announcements**: write the announcement and publish it. It becomes visible to the organisation on their dashboards.

### Super Admin only
Super Admin holds every permission, including managing the role/permission matrix itself and assigning the Super Admin, Founder and HR roles. Admin can run day-to-day operations (projects, allocations, import, automation, monitoring) but cannot escalate roles beyond its own grant.

---

## 2.5 FOUNDER

### The executive dashboard
Founders get a read-only, organisation-wide view: **Organisation** and **Team Review** with the same attendance status mix, productivity and achievement metrics, consolidated EOD reports, and the workforce directory.

How to read it:
- A rising share of **Present — Hours Incomplete** or **Missed Check-Out** means process discipline is slipping, not necessarily low output.
- **Uncovered** time is the honest gap indicator: worked time with no task, break or blocker behind it.
- **Achievement %** compares real units logged against the project's own targets, so it is comparable across projects.

### What Founders cannot do
- No **My Day** check-in/check-out widget — Founders do not log daily attendance.
- No editing: no creating projects, no allocating people, no approving requests, no inviting or verifying staff, no role changes. The Founder view is deliberately observational and enforced on the server, not just hidden in the menu.

---

## 3. Common questions / troubleshooting

**"Why can't I log hourly tasks?"**
You must have an **active, acknowledged** assignment for today. Open **My Assignments** and click **Acknowledge assignment**. If nothing is listed, your Admin has not allocated you yet. You must also be checked in.

**"Why is my leave request stuck on Pending?"**
Employee requests need **both** your Lead and HR. One approval is not enough. Check the approval trail on the request to see who is still pending and nudge them. Lead requests need HR only.

**"Why do I see an access-denied page?"**
Every action is checked against your role's permissions on the server. If your role does not hold the permission, you get the not-authorised screen — even if you reached the page by a direct link. Ask HR or an Admin if you believe your role is wrong.

**"My reporting lead isn't assigned."**
You will be blocked from submitting leave/WFH/correction requests, and your name will appear on the unassigned-reporting-lead warning that HR and Admin see. Contact HR and ask them to set your reporting lead on your Workforce record; requests unblock immediately after.

**"My entry says approved and I can't edit it."**
Approved entries are locked by design. Ask your lead to request a revision, or raise an attendance-correction request.

**"I checked in but forgot to check out."**
Your day derives as **Missed Check-Out** and is flagged automatically. Submit an **Attendance correction** request with the real times.

---

## 4. Known limitations (honest list)

- **Deferred import rows.** Legacy rows sent to the manual-mapping queue and neither invited nor skipped stay pending indefinitely; they are not imported and there is no automatic reminder to clear the queue.
- **Ambiguous legacy dates.** A small number of malformed date headers in old workbooks cannot be resolved automatically and are deliberately left for manual mapping rather than guessed.
- **Password self-service.** There is no dedicated "forgot password" screen; recovery is via the email sign-in link.
- **Notifications are in-app only.** The bell is authoritative; there are no push or email notifications for blockers, reviews or approvals (invitation emails are the exception).
- **Reporting-lead backfill is one-time.** Existing lead-less accounts were backfilled once; new gaps are surfaced but must still be fixed by a human.
- **Automation scheduling.** Rules are correct and idempotent, and the manual trigger is verified; long-horizon unattended scheduling has been exercised only through manual and short-interval runs.
- **Announcements** support create-and-publish; there is no scheduling, targeting by role, or read-receipt tracking.
- **Exports** are CSV. There is no native .xlsx export yet (CSV opens cleanly in Excel).
- **Historical imports do not backfill EOD reports or task entries** — only attendance signals and calendar days.
