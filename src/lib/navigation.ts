import {
  actorCan,
  canExportReports,
  isExecutiveGovernanceOnly,
  resolvePrimaryRole,
  type Actor,
} from "./permissions";

export type NavIconKey =
  | "dashboard"
  | "my_day"
  | "my_work"
  | "profile"
  | "workforce"
  | "invitations"
  | "candidates"
  | "interviews"
  | "emails"
  | "projects"
  | "oversight"
  | "reviews"
  | "requests"
  | "reports"
  | "org"
  | "automation"
  | "relieving";

export type RoleNavItem = {
  to: string;
  label: string;
  iconKey: NavIconKey;
  matchPrefixes: string[];
};

export type RoleNavGroup = {
  id: string;
  label: string;
  collapsible?: boolean;
  items: RoleNavItem[];
};

export function isNavItemActive(pathname: string, item: RoleNavItem): boolean {
  return item.matchPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Pure, role-aware sidebar navigation builder for all 7 authorization roles.
 * Enforces permission checks while keeping the HR Recruitment & Communication flow
 * (`HR Dashboard` -> `Candidates` -> `Interviews` -> `Email Center` -> `Onboarding` -> `Workforce`)
 * clean and direct.
 */
export function buildRoleNavigation(
  actor: Pick<
    Actor,
    | "roles"
    | "permissions"
    | "accountStatus"
    | "userId"
    | "fullName"
    | "workEmail"
    | "category"
  >,
): RoleNavGroup[] {
  const fullActor = actor as Actor;
  const primaryRole = resolvePrimaryRole(actor.roles);
  const execOnly = isExecutiveGovernanceOnly(actor.roles);
  const canExport = canExportReports(actor.roles, actor.permissions);

  const canMyDay = !execOnly && actorCan(fullActor, "attendance:log:self");
  const canMyWork = !execOnly && actorCan(fullActor, "allocations:acknowledge:self");
  const canWorkforce =
    actorCan(fullActor, "workforce:read:all") || actorCan(fullActor, "workforce:read:team");
  const canInvites = actorCan(fullActor, "invitations:read:all");
  const canRecruitmentRead = actorCan(fullActor, "recruitment:read:all");
  const canInterviewsRead = actorCan(fullActor, "interviews:read:all");
  const canAssignedInterviews = actorCan(fullActor, "interviews:feedback:assigned");
  const canEmailsRead = actorCan(fullActor, "emails:read:all");
  const canProjects =
    actorCan(fullActor, "projects:read:all") || actorCan(fullActor, "projects:read:team");
  const canOversight =
    actorCan(fullActor, "attendance:read:all") || actorCan(fullActor, "attendance:read:team");
  const canTaskReviews =
    actorCan(fullActor, "tasks:read:team") || actorCan(fullActor, "tasks:review:team");
  const canRequests =
    actorCan(fullActor, "requests:read:self") ||
    actorCan(fullActor, "requests:read:team") ||
    actorCan(fullActor, "requests:read:all");
  const canOrgHub =
    actorCan(fullActor, "org:manage:all") ||
    actorCan(fullActor, "audit:read:all") ||
    actorCan(fullActor, "rbac:manage:all");
  const canAutomation = actorCan(fullActor, "automation:run:all");
  const canImports = actorCan(fullActor, "import:manage:all");
  const canRelieving = actorCan(fullActor, "relieving:read:all");

  const personalItems: RoleNavItem[] = [
    ...(canMyDay
      ? [
          {
            to: "/my-day",
            label: "My Day",
            iconKey: "my_day" as const,
            matchPrefixes: ["/my-day"],
          },
        ]
      : []),
    ...(canMyWork
      ? [
          {
            to: "/my-projects",
            label: "My Assignments",
            iconKey: "my_work" as const,
            matchPrefixes: ["/my-projects"],
          },
        ]
      : []),
    {
      to: "/onboarding",
      label: "My Profile",
      iconKey: "profile",
      matchPrefixes: ["/onboarding"],
    },
  ];

  // 1. Founder (strictly read-only executive oversight)
  if (primaryRole === "founder" && execOnly) {
    const items: RoleNavItem[] = [
      {
        to: "/dashboard",
        label: "Executive Dashboard",
        iconKey: "dashboard",
        matchPrefixes: ["/dashboard"],
      },
    ];
    if (canExport) {
      items.push({
        to: "/reports",
        label: "Reports & Exports",
        iconKey: "reports",
        matchPrefixes: ["/reports"],
      });
    }
    if (canOversight) {
      items.push({
        to: "/team",
        label: "Attendance & Breaks",
        iconKey: "oversight",
        matchPrefixes: ["/team"],
      });
    }
    if (canProjects) {
      items.push({
        to: "/projects",
        label: "Project Portfolio",
        iconKey: "projects",
        matchPrefixes: ["/projects"],
      });
    }
    if (canRecruitmentRead) {
      items.push({
        to: "/candidates",
        label: "Recruitment Overview",
        iconKey: "candidates",
        matchPrefixes: ["/candidates", "/interviews", "/email-center"],
      });
    }
    if (canWorkforce) {
      items.push({
        to: "/workforce",
        label: "Workforce Directory",
        iconKey: "workforce",
        matchPrefixes: ["/workforce"],
      });
    }
    if (canRequests) {
      items.push({
        to: "/requests",
        label: "Requests Overview",
        iconKey: "requests",
        matchPrefixes: ["/requests"],
      });
    }
    items.push({
      to: "/onboarding",
      label: "My Profile",
      iconKey: "profile",
      matchPrefixes: ["/onboarding"],
    });
    return [{ id: "executive", label: "Executive Oversight", items }];
  }

  // 2. Employee (clean 5-item personal workspace, zero recruitment administration)
  if (primaryRole === "employee") {
    const items: RoleNavItem[] = [
      {
        to: "/dashboard",
        label: "Dashboard",
        iconKey: "dashboard",
        matchPrefixes: ["/dashboard"],
      },
      ...personalItems.filter((i) => i.to !== "/onboarding"),
    ];
    if (canRequests) {
      items.push({
        to: "/requests",
        label: "Leave & Requests",
        iconKey: "requests",
        matchPrefixes: ["/requests"],
      });
    }
    items.push({
      to: "/onboarding",
      label: "My Profile",
      iconKey: "profile",
      matchPrefixes: ["/onboarding"],
    });
    return [{ id: "workspace", label: "My Workspace", items }];
  }

  // 3. Lead & 4. Manager (supervisory & scoped management + assigned interview scorecards)
  if (primaryRole === "lead" || primaryRole === "manager") {
    const teamItems: RoleNavItem[] = [
      {
        to: "/dashboard",
        label: "Dashboard",
        iconKey: "dashboard",
        matchPrefixes: ["/dashboard"],
      },
    ];
    if (canProjects) {
      teamItems.push({
        to: "/projects",
        label: primaryRole === "manager" ? "Scoped Projects" : "Projects",
        iconKey: "projects",
        matchPrefixes: ["/projects"],
      });
    }
    if (canOversight) {
      teamItems.push({
        to: "/team",
        label: "Attendance & Breaks",
        iconKey: "oversight",
        matchPrefixes: ["/team"],
      });
    }
    if (canTaskReviews) {
      teamItems.push({
        to: "/reviews",
        label: "Task Reviews",
        iconKey: "reviews",
        matchPrefixes: ["/reviews"],
      });
    }
    if (canRequests) {
      teamItems.push({
        to: "/requests",
        label: "Requests & Approvals",
        iconKey: "requests",
        matchPrefixes: ["/requests"],
      });
    }
    if (canAssignedInterviews) {
      teamItems.push({
        to: "/interviews",
        label: "Assigned Interviews",
        iconKey: "interviews",
        matchPrefixes: ["/interviews"],
      });
    }
    if (canWorkforce) {
      teamItems.push({
        to: "/workforce",
        label: primaryRole === "manager" ? "Scoped Directory" : "Team Directory",
        iconKey: "workforce",
        matchPrefixes: ["/workforce"],
      });
    }
    if (canExport) {
      teamItems.push({
        to: "/reports",
        label: "Scoped Reports",
        iconKey: "reports",
        matchPrefixes: ["/reports"],
      });
    }

    return [
      {
        id: "supervision",
        label: primaryRole === "manager" ? "Managed Scope" : "Team Supervision",
        items: teamItems,
      },
      {
        id: "personal",
        label: "Personal Workspace",
        collapsible: primaryRole === "manager",
        items: personalItems,
      },
    ];
  }

  // 5. HR — Primary flow: HR Dashboard -> Candidates -> Interviews -> Email Center -> Onboarding -> Workforce
  if (primaryRole === "hr") {
    const hrItems: RoleNavItem[] = [
      {
        to: "/dashboard",
        label: "HR Dashboard",
        iconKey: "dashboard",
        matchPrefixes: ["/dashboard"],
      },
    ];
    if (canRecruitmentRead) {
      hrItems.push({
        to: "/candidates",
        label: "Candidates",
        iconKey: "candidates",
        matchPrefixes: ["/candidates"],
      });
    }
    if (canInterviewsRead || canAssignedInterviews) {
      hrItems.push({
        to: "/interviews",
        label: "Interviews",
        iconKey: "interviews",
        matchPrefixes: ["/interviews"],
      });
    }
    if (canEmailsRead) {
      hrItems.push({
        to: "/email-center",
        label: "Email Center",
        iconKey: "emails",
        matchPrefixes: ["/email-center"],
      });
    }
    if (canInvites) {
      hrItems.push({
        to: "/invitations",
        label: "Onboarding",
        iconKey: "invitations",
        matchPrefixes: ["/invitations", "/roster-import"],
      });
    }
    if (canWorkforce) {
      hrItems.push({
        to: "/workforce",
        label: "Workforce",
        iconKey: "workforce",
        matchPrefixes: ["/workforce"],
      });
    }
    if (canRelieving) {
      hrItems.push({
        to: "/employee-relieving",
        label: "Employee Relieving",
        iconKey: "relieving",
        matchPrefixes: ["/employee-relieving"],
      });
    }
    if (canRequests) {
      hrItems.push({
        to: "/requests",
        label: "HR Approvals",
        iconKey: "requests",
        matchPrefixes: ["/requests"],
      });
    }

    const oversightItems: RoleNavItem[] = [];
    if (canOversight) {
      oversightItems.push({
        to: "/team",
        label: "Attendance & Breaks",
        iconKey: "oversight",
        matchPrefixes: ["/team", "/reviews"],
      });
    }
    if (canProjects) {
      oversightItems.push({
        to: "/projects",
        label: "Projects",
        iconKey: "projects",
        matchPrefixes: ["/projects"],
      });
    }
    if (canExport) {
      oversightItems.push({
        to: "/reports",
        label: "Reports & Exports",
        iconKey: "reports",
        matchPrefixes: ["/reports"],
      });
    }
    if (canOrgHub) {
      oversightItems.push({
        to: "/org",
        label: "Org & Calendar",
        iconKey: "org",
        matchPrefixes: ["/org", "/office-locations"],
      });
    }
    if (canAutomation || canImports) {
      oversightItems.push({
        to: canAutomation ? "/automation" : "/import",
        label: canAutomation ? "Automation & Imports" : "Attendance Imports",
        iconKey: "automation",
        matchPrefixes: ["/automation", "/import"],
      });
    }

    return [
      { id: "people", label: "Recruitment & Workforce", items: hrItems },
      ...(oversightItems.length > 0
        ? [{ id: "analytics_gov", label: "Oversight & Reports", items: oversightItems }]
        : []),
      { id: "personal", label: "Personal Workspace", collapsible: true, items: personalItems },
    ];
  }

  // 6. Admin & 7. Super Admin — consolidated hubs + collapsible personal self-service
  const deliveryItems: RoleNavItem[] = [
    {
      to: "/dashboard",
      label: primaryRole === "super_admin" ? "System Dashboard" : "Operations Dashboard",
      iconKey: "dashboard",
      matchPrefixes: ["/dashboard"],
    },
  ];

  if (canProjects) {
    deliveryItems.push({
      to: "/projects",
      label: "Projects & Capacity",
      iconKey: "projects",
      matchPrefixes: ["/projects"],
    });
  }
  if (canOversight) {
    deliveryItems.push({
      to: "/team",
      label: "Attendance & Breaks",
      iconKey: "oversight",
      matchPrefixes: ["/team", "/reviews"],
    });
  }
  if (canRequests) {
    deliveryItems.push({
      to: "/requests",
      label: "Requests & Approvals",
      iconKey: "requests",
      matchPrefixes: ["/requests"],
    });
  }
  if (canExport) {
    deliveryItems.push({
      to: "/reports",
      label: "Reports & Exports",
      iconKey: "reports",
      matchPrefixes: ["/reports"],
    });
  }

  const peopleAndGovItems: RoleNavItem[] = [];
  if (canRecruitmentRead) {
    peopleAndGovItems.push({
      to: "/candidates",
      label: primaryRole === "super_admin" ? "Recruitment & Emails" : "Recruitment Pipeline",
      iconKey: "candidates",
      matchPrefixes: ["/candidates", "/interviews", "/email-center"],
    });
  }
  if (canWorkforce) {
    peopleAndGovItems.push({
      to: "/workforce",
      label: primaryRole === "super_admin" ? "Workforce & Roles" : "Workforce Directory",
      iconKey: "workforce",
      matchPrefixes: ["/workforce"],
    });
  }
  if (canRelieving) {
    peopleAndGovItems.push({
      to: "/employee-relieving",
      label: "Employee Relieving",
      iconKey: "relieving",
      matchPrefixes: ["/employee-relieving"],
    });
  }
  if (canInvites) {
    peopleAndGovItems.push({
      to: "/invitations",
      label: "Onboarding & Invites",
      iconKey: "invitations",
      matchPrefixes: ["/invitations", "/roster-import"],
    });
  }
  if (canOrgHub) {
    peopleAndGovItems.push({
      to: "/org",
      label: primaryRole === "super_admin" ? "Org, RBAC & Geofences" : "Org & Geofences",
      iconKey: "org",
      matchPrefixes: ["/org", "/office-locations"],
    });
  }
  if (canAutomation || canImports) {
    peopleAndGovItems.push({
      to: canAutomation ? "/automation" : "/import",
      label: "Automation & Imports",
      iconKey: "automation",
      matchPrefixes: ["/automation", "/import"],
    });
  }

  return [
    { id: "delivery", label: "Operations & Delivery", items: deliveryItems },
    ...(peopleAndGovItems.length > 0
      ? [{ id: "governance", label: "People & Governance", items: peopleAndGovItems }]
      : []),
    {
      id: "personal",
      label: execOnly ? "Account" : "Personal Workspace",
      collapsible: true,
      items: personalItems,
    },
  ];
}
