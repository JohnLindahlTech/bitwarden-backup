// Pure logic for mirroring a backup into a vault: markers, fingerprints and the plan. No I/O here.
//
// Every mirrored item carries custom fields on the TARGET item, so the mapping lives inside the vault itself:
//   bwbu:v1:src  id of the item in the source vault (the lookup key)
//   bwbu:v1:fp   fingerprint of the source content that was written, to skip unchanged items
//   bwbu:v1:att  JSON [{i: source attachment id, t: target attachment id}] of the synced attachments
import crypto from 'node:crypto';

export const MARKER = { src: 'bwbu:v1:src', fp: 'bwbu:v1:fp', att: 'bwbu:v1:att' };
const isMarker = (field) => typeof field?.name === 'string' && field.name.startsWith('bwbu:v1:');
const markerField = (name, value) => ({ name, value, type: 0, linkedId: null });

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== null && value[k] !== undefined).map((k) => [k, canonical(value[k])]));
  }
  return value;
};

// What a restore can write. Passkeys (fido2Credentials) and the dates Bitwarden manages itself are left out.
function cleanContent(item) {
  const content = {};
  for (const key of ['type', 'name', 'notes', 'favorite', 'reprompt', 'login', 'card', 'identity', 'secureNote']) {
    if (item[key] !== undefined && item[key] !== null) content[key] = item[key];
  }
  if (content.login) {
    content.login = { ...content.login };
    delete content.login.passwordRevisionDate;
    delete content.login.fido2Credentials;
  }
  content.fields = (item.fields ?? []).filter((f) => !isMarker(f)).map(({ name, value, type, linkedId }) => ({ name, value, type, linkedId: linkedId ?? null }));
  content.passwordHistory = (item.passwordHistory ?? []).map(({ password, lastUsedDate }) => ({ password, lastUsedDate }));
  return content;
}

// `bw list folders` also returns a pseudo folder "No Folder" with a null id, an item without folder has no folder name.
export const folderNames = (folders) => new Map(folders.filter((f) => f.id).map((f) => [f.id, f.name]));

export function fingerprint(item, folderName) {
  const content = { ...cleanContent(item), folder: folderName ?? null };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex').slice(0, 32);
}

export const readMarkers = (item) => {
  const get = (name) => (item.fields ?? []).find((f) => f.name === name)?.value;
  let attachments = [];
  try { attachments = JSON.parse(get(MARKER.att) ?? '[]'); } catch { /* damaged marker: treated as no synced attachments */ }
  return { src: get(MARKER.src), fp: get(MARKER.fp), attachments: Array.isArray(attachments) ? attachments : [] };
};

// The item as sent to `bw create/edit item`, with the markers.
export function targetPayload(item, { folderId, fp, attachments = [] }) {
  const payload = { ...cleanContent(item), folderId: folderId ?? null, organizationId: null };
  payload.fields = [
    ...payload.fields,
    markerField(MARKER.src, item.id),
    markerField(MARKER.fp, fp),
    ...(attachments.length ? [markerField(MARKER.att, JSON.stringify(attachments))] : []),
  ];
  return payload;
}

// Same as targetPayload for an existing target item, where only the attachment marker changes.
export function withAttachmentMarker(targetItem, attachments) {
  const fields = (targetItem.fields ?? []).filter((f) => f.name !== MARKER.att);
  if (attachments.length) fields.push(markerField(MARKER.att, JSON.stringify(attachments)));
  const { attachments: _drop, ...rest } = targetItem;
  return { ...rest, fields };
}

// Markers for an item that is bulk-imported (export.json format), so no second pass is needed to adopt it.
export function markFieldsForImport(existingFields, item, fp) {
  return [...(existingFields ?? []), markerField(MARKER.src, item.id), markerField(MARKER.fp, fp)];
}

/**
 * Compares the backed up items with the target vault.
 *  - create / update / unchanged: by marker, update when the fingerprint differs (or `force`)
 *  - restoreFromTrash: the item is back in the source but its mirror sits in the target's trash
 *  - trash: mirrored items that are no longer in the source
 *  - attachments: per source item, which to upload and which synced copies to remove
 */
export function planSync({ sourceItems, sourceFolders, targetItems, targetTrashed = [], force = false }) {
  const names = folderNames(sourceFolders);
  const bySrc = (items) => items.reduce((m, t) => {
    const { src } = readMarkers(t);
    return src ? m.set(src, [...(m.get(src) ?? []), t]) : m;
  }, new Map());
  const live = bySrc(targetItems), trashed = bySrc(targetTrashed);

  const plan = { create: [], update: [], unchanged: [], restoreFromTrash: [], trash: [], duplicates: [], unmanaged: targetItems.filter((t) => !readMarkers(t).src).length };
  const sourceIds = new Set(sourceItems.map((i) => i.id));

  for (const item of sourceItems) {
    const fp = fingerprint(item, names.get(item.folderId ?? null));
    const folderName = names.get(item.folderId ?? null) ?? null;
    const [target, ...extra] = live.get(item.id) ?? [];
    if (extra.length) plan.duplicates.push({ source: item.id, targets: [target, ...extra].map((t) => t.id) });
    const synced = (target ? readMarkers(target).attachments : []);
    const sourceAttachments = item.attachments ?? [];
    const upload = sourceAttachments.filter((a) => !synced.some((s) => s.i === a.id));
    const remove = synced.filter((s) => !sourceAttachments.some((a) => a.id === s.i));
    const entry = { item, fp, folderName, upload, remove, target };

    if (!target) {
      const back = trashed.get(item.id)?.[0];
      if (back) plan.restoreFromTrash.push({ ...entry, target: back, upload: sourceAttachments.filter((a) => !readMarkers(back).attachments.some((s) => s.i === a.id)), remove: readMarkers(back).attachments.filter((s) => !sourceAttachments.some((a) => a.id === s.i)) });
      else plan.create.push(entry);
    } else if (force || readMarkers(target).fp !== fp) plan.update.push(entry);
    else if (upload.length || remove.length) plan.update.push({ ...entry, contentUnchanged: true });
    else plan.unchanged.push(entry);
  }
  for (const [src, targets] of live) if (!sourceIds.has(src)) plan.trash.push(...targets);
  return plan;
}
