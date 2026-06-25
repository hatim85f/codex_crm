const Team = require("../models/Team");

// Role visibility for the Leads & Intake module:
//  - owner_admin / admin  -> see everything in the tenant
//  - team_leader (manager) -> records assigned to them OR to members of teams they lead
//  - everyone else         -> only records assigned to them
const canSeeAllLeads = (req) => ["owner_admin", "admin"].includes(req.user.role);

// The set of user ids whose assigned records the current (non-admin) user may see.
// Returned as an array of strings; always includes the user themselves.
async function visibleAssigneeIds(req) {
  const me = String(req.user.id);
  if (req.user.role !== "team_leader") return [me];
  const teams = await Team.find({
    organization: req.user.organization,
    teamLeaderId: req.user.id,
  }).select("members.userId");
  const ids = new Set([me]);
  teams.forEach((t) => (t.members || []).forEach((m) => m.userId && ids.add(String(m.userId))));
  return [...ids];
}

// A Mongo $and clause that limits a query to the records this user may see.
// Pass the field that holds the assignee (defaults to "assignedTo").
async function assignedScope(req, field = "assignedTo") {
  if (canSeeAllLeads(req)) return null;
  const ids = await visibleAssigneeIds(req);
  return { [field]: { $in: ids } };
}

module.exports = { canSeeAllLeads, visibleAssigneeIds, assignedScope };
