/**
 * Skill Permission Review API.
 *
 * GET /api/skill-permissions — current user's visible skills with inferred
 * read/write/send/control/admin capability flags and assignment context.
 */

import {
  requireAuth, getUserEnabledSkills, getAgentsForUser, safeError,
} from './_helpers.mjs';
import { listRoles, getRoleAssignments, getRoleTools } from '../roles.mjs';
import { summarizeSkillPermissions } from '../lib/skill-permissions.mjs';

export async function handle(req, res) {
  if (req.url === '/api/skill-permissions' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const enabled = new Set(getUserEnabledSkills(authId));
      const assignments = getRoleAssignments(authId);
      const agents = getAgentsForUser(authId);
      const agentById = new Map(agents.map(a => [a.id, { id: a.id, name: a.name, emoji: a.emoji ?? '' }]));
      const skills = listRoles(authId)
        .filter(m => !m.hidden)
        .map(m => {
          const assignment = assignments[m.id] ?? null;
          return summarizeSkillPermissions(m, {
            enabled: enabled.has(m.id),
            assignment,
            assignedAgent: assignment ? (agentById.get(assignment) ?? { id: assignment, name: assignment, emoji: '' }) : null,
            tools: getRoleTools(m.id, authId),
          });
        })
        .sort((a, b) => {
          const riskRank = { high: 0, medium: 1, low: 2 };
          return (riskRank[a.risk] ?? 9) - (riskRank[b.risk] ?? 9)
            || Number(b.enabled) - Number(a.enabled)
            || a.name.localeCompare(b.name);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Slim roster only — the resolved agents carry fully-composed system
      // prompts + full tool schemas (hundreds of KB, and a child user's
      // entry included the verbatim child-safety prompt). The panel needs
      // id/name/emoji at most.
      res.end(JSON.stringify({ skills, agents: [...agentById.values()] }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}
