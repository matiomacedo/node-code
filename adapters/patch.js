'use strict';
// The "*** Begin Patch" format that Copilot's apply_patch and OpenCode's patch
// tools take. One patch may add, update, move and delete several files.

const PATCH_LINE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm;

// The files that exist once the patch has run. A deleted file is left out: the
// server drops it on its next scan. A moved file counts as created at its new path.
function patchFiles(patch) {
  const files = [];
  for (const [, op, rawPath] of patch.matchAll(PATCH_LINE)) {
    const filePath = rawPath.trim();
    if (op === 'Add File') files.push({ filePath, created: true });
    else if (op === 'Update File') files.push({ filePath, created: false });
    else if (op === 'Delete File') files.push(null); // so a following "Move to" has nothing to move
    else if (files.length && files[files.length - 1]) files[files.length - 1] = { filePath, created: true };
  }
  return files.filter(Boolean);
}

// The Claude-shaped fields for a patch: an Edit of the first file, with every file
// listed as changed once it has run, so the server refreshes each one. A patch
// that leaves no file to point at is not an Edit, which the server expects to
// have a file path.
function editFromPatch(patch, { finished }) {
  const files = patchFiles(patch);
  if (!files.length) return { tool_name: 'Patch', tool_input: {} };
  const out = { tool_name: 'Edit', tool_input: { file_path: files[0].filePath } };
  if (finished) {
    out.tool_response = {
      type: files[0].created ? 'create' : 'update',
      bashEditDiff: { changedFiles: files.map((f) => f.filePath), files },
    };
  }
  return out;
}

module.exports = { editFromPatch };
