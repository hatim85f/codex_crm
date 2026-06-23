const Project = require("../models/Project");
const ProjectStep = require("../models/ProjectStep");

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// Compute weighted progress from a project's active (non-deleted) steps.
// weightedContribution = weight * progress / 100  (summed, then clamped 0..100)
function computeFromSteps(steps) {
  const active = steps.filter((s) => !s.isDeleted);
  const totalWeight = active.reduce((sum, s) => sum + (Number(s.weight) || 0), 0);
  const raw = active.reduce((sum, s) => sum + ((Number(s.weight) || 0) * clamp(Number(s.progress) || 0)) / 100, 0);
  return {
    totalWeight: Math.round(totalWeight * 100) / 100,
    progress: clamp(Math.round(raw * 100) / 100),
    stepCount: active.length,
  };
}

// Recalculate and persist a project's progress/hasSteps from its steps.
// Only overrides project.progress when progressCalculationMode === "steps".
async function recalcProjectProgress(projectId) {
  const project = await Project.findById(projectId);
  if (!project) return null;
  const steps = await ProjectStep.find({ projectId, isDeleted: false });
  const { progress, totalWeight, stepCount } = computeFromSteps(steps);
  project.hasSteps = stepCount > 0;
  if (project.hasSteps && (project.progressCalculationMode || "steps") === "steps") {
    project.progress = progress;
  }
  await project.save();
  return { project, progress, totalWeight, stepCount };
}

module.exports = { recalcProjectProgress, computeFromSteps, clamp };
