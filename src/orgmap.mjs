// Which organization of the backup goes into which organization of the target account. Pure logic, no I/O.

// Why we cannot export from / write to this organization (undefined when we can). Types: 0 owner, 1 admin, 2 user.
export function exportBlocker(org) {
  if (org.enabled === false) return 'the organization is disabled';
  if (org.status !== undefined && org.status !== 2) return 'your membership is not confirmed yet';
  const canExport = org.permissions?.accessImportExport ?? (org.type === 0 || org.type === 1);
  if (!canExport) return 'you are not an owner/admin of the organization (no export permission)';
}

/**
 * sourceOrgs:    [{ id, name, itemIds: Set }]   organizations in the backup
 * targetOrgs:    organizations of the target account (as `bw list organizations`)
 * explicit:      { sourceId: targetId }          what the user asked for with --org
 * markedSources: Map(targetOrgId -> Set of source item ids found as markers in that org)
 *
 * Order: explicit, then markers from earlier runs, then a unique name match. Anything else is NOT guessed.
 * Returns { mapping: Map(sourceId -> targetOrg), unmapped: [{ org, reason }] }
 */
export function resolveOrgMapping({ sourceOrgs, targetOrgs, explicit = {}, markedSources = new Map() }) {
  const usable = targetOrgs.filter((t) => !exportBlocker(t));
  const mapping = new Map();
  const unmapped = [];
  const taken = () => new Set([...mapping.values()].map((t) => t.id));

  const fail = (org, reason) => unmapped.push({ org, reason });
  const claim = (org, target) => {
    if (taken().has(target.id)) return fail(org, `the target organization ${target.id} is already used for another backed-up organization`);
    mapping.set(org.id, target);
  };

  const pending = [];
  for (const org of sourceOrgs) {
    if (explicit[org.id]) {
      const target = usable.find((t) => t.id === explicit[org.id]);
      if (target) claim(org, target);
      else fail(org, `--org points to ${explicit[org.id]}, which is not an organization you can write to`);
      continue;
    }
    const byMarkers = usable.filter((t) => [...(markedSources.get(t.id) ?? [])].some((src) => org.itemIds.has(src)));
    if (byMarkers.length === 1) claim(org, byMarkers[0]);
    else if (byMarkers.length > 1) fail(org, `its items were mirrored into several organizations (${byMarkers.map((t) => t.id).join(', ')}), choose with --org`);
    else pending.push(org);
  }
  for (const org of pending) {
    const sameNameSources = pending.filter((o) => o.name === org.name);
    const sameNameTargets = usable.filter((t) => t.name === org.name && !taken().has(t.id));
    if (sameNameSources.length === 1 && sameNameTargets.length === 1) claim(org, sameNameTargets[0]);
    else if (sameNameTargets.length === 0) {
      const used = usable.some((t) => t.name === org.name);
      fail(org, used ? 'the organization with that name on the target is already used for another backed-up organization (choose with --org)'
        : 'no organization with that name exists on the target (create it first, or choose one with --org)');
    }
    else fail(org, `several organizations could match (${sameNameSources.length} backed up, ${sameNameTargets.length} on the target with that name), choose with --org`);
  }
  return { mapping, unmapped };
}
