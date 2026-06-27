// Business-form (department) grouping used by the Task Center so admins/managers
// can see all company tasks split by Sales, Marketing, Development, etc.
// A task's department is derived from the assignee's role (or set explicitly).

const DEPARTMENTS = [
  "general", "sales", "marketing", "development",
  "design", "content", "accounting", "support", "management",
];

// Internal role -> department.
const ROLE_DEPARTMENT = {
  sales: "sales",
  marketing: "marketing",
  developer: "development",
  designer: "design",
  content_creator: "content",
  accountant: "accounting",
  support: "support",
  team_leader: "management",
  admin: "management",
  owner_admin: "management",
};

function departmentForRole(role) {
  return ROLE_DEPARTMENT[role] || "general";
}

module.exports = { DEPARTMENTS, departmentForRole };
