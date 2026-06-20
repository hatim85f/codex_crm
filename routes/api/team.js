const express = require("express");

const router = express.Router();
const Team = require("../../models/Team");
const User = require("../../models/User");
const { auth, requireRole } = require("../../middleware/auth");

router.use(auth);

const populateTeam = (q) =>
  q
    .populate("teamLeaderId", "name email role")
    .populate("members.userId", "name email role status");

// POST /api/teams
router.post("/", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { name, type, department, description, teamLeaderId, status } = req.body || {};
    if (!name) return res.status(400).json({ message: "Team name is required" });

    const team = await Team.create({
      name,
      organization: req.user.organization, // company scope
      type: type || "general",
      department: department || "",
      description: description || "",
      teamLeaderId: teamLeaderId || null,
      status: status === "inactive" ? "inactive" : "active",
      members: [],
    });

    // if a leader is set, ensure they are a member
    if (teamLeaderId) {
      team.members.push({ userId: teamLeaderId, roleInTeam: "leader" });
      await team.save();
      await User.findByIdAndUpdate(teamLeaderId, { $addToSet: { generalTeams: team._id } });
    }

    const out = await populateTeam(Team.findById(team._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("create team error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/teams
router.get("/", async (req, res) => {
  try {
    const teams = await populateTeam(
      Team.find({ organization: req.user.organization })
    ).sort({ createdAt: -1 });
    return res.json(teams);
  } catch (err) {
    console.error("list teams error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/teams/:id
router.get("/:id", async (req, res) => {
  try {
    const team = await populateTeam(Team.findById(req.params.id));
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }
    return res.json(team);
  } catch (err) {
    console.error("get team error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/teams/:id
router.put("/:id", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { name, department, description, status, teamLeaderId } = req.body || {};
    const team = await Team.findById(req.params.id);
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }

    if (name !== undefined) team.name = name;
    if (department !== undefined) team.department = department;
    if (description !== undefined) team.description = description;
    if (status !== undefined) team.status = status;
    if (teamLeaderId !== undefined) team.teamLeaderId = teamLeaderId || null;

    await team.save();
    const out = await populateTeam(Team.findById(team._id));
    return res.json(out);
  } catch (err) {
    console.error("update team error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/teams/:id/status
router.patch("/:id/status", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: "status must be 'active' or 'inactive'" });
    }
    const team = await Team.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization },
      { status },
      { new: true }
    );
    if (!team) return res.status(404).json({ message: "Team not found" });
    return res.json(team);
  } catch (err) {
    console.error("status team error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/teams/:id/members  { userId, roleInTeam }
router.post("/:id/members", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { userId, roleInTeam } = req.body || {};
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const team = await Team.findById(req.params.id);
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }

    const already = team.members.some((m) => String(m.userId) === String(userId));
    if (!already) {
      team.members.push({ userId, roleInTeam: roleInTeam || "member" });
      await team.save();
      await User.findByIdAndUpdate(userId, { $addToSet: { generalTeams: team._id } });
    }

    const out = await populateTeam(Team.findById(team._id));
    return res.json(out);
  } catch (err) {
    console.error("add member error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/teams/:id/members/:userId
router.delete("/:id/members/:userId", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { id, userId } = req.params;
    const team = await Team.findById(id);
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }

    team.members = team.members.filter((m) => String(m.userId) !== String(userId));
    if (team.teamLeaderId && String(team.teamLeaderId) === String(userId)) {
      team.teamLeaderId = null;
    }
    await team.save();
    await User.findByIdAndUpdate(userId, { $pull: { generalTeams: team._id } });

    const out = await populateTeam(Team.findById(team._id));
    return res.json(out);
  } catch (err) {
    console.error("remove member error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/teams/:id/leader  { teamLeaderId }
router.patch("/:id/leader", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { teamLeaderId } = req.body || {};
    const team = await Team.findById(req.params.id);
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }

    team.teamLeaderId = teamLeaderId || null;
    if (teamLeaderId) {
      const isMember = team.members.some((m) => String(m.userId) === String(teamLeaderId));
      if (!isMember) {
        team.members.push({ userId: teamLeaderId, roleInTeam: "leader" });
        await User.findByIdAndUpdate(teamLeaderId, { $addToSet: { generalTeams: team._id } });
      }
    }
    await team.save();

    const out = await populateTeam(Team.findById(team._id));
    return res.json(out);
  } catch (err) {
    console.error("set leader error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/teams/:id  -> hard-delete an INACTIVE team that has no work history
router.delete("/:id", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const team = await Team.findById(req.params.id);
    if (!team || String(team.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Team not found" });
    }
    if (team.status !== "inactive") {
      return res
        .status(400)
        .json({ message: "Deactivate the team before deleting it." });
    }

    // Work-history guard (extensible). A team that has been used in real work must
    // never be hard-deleted. No work modules exist yet, so this count is 0 today.
    // When Projects / Quotations / Invoices / Tasks are added, count references to
    // this team here and block deletion if any exist.
    const workHistoryCount = 0;
    if (workHistoryCount > 0) {
      return res.status(409).json({
        message: "This team has work history and cannot be deleted. Keep it inactive instead.",
      });
    }

    // Detach the team from members' generalTeams, then remove it.
    await User.updateMany(
      { generalTeams: team._id },
      { $pull: { generalTeams: team._id } }
    );
    await team.deleteOne();

    return res.json({ ok: true, _id: team._id });
  } catch (err) {
    console.error("delete team error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
