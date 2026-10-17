import type { WorkspaceFile } from './workspaces.js';
export interface WorkspaceChange {
  path: string;
  before: WorkspaceFile | null;
  after: WorkspaceFile | null;
}
/** Whole-file unified hunks retain exact line endings and missing-final-newline markers. */
export function workspaceDiff(file: WorkspaceChange): string {
  const old = Buffer.from(file.before?.content ?? '', 'base64'),
    next = Buffer.from(file.after?.content ?? '', 'base64');
  const before = old.toString('utf8'),
    after = next.toString('utf8');
  if (
    !Buffer.from(before).equals(old) ||
    !Buffer.from(after).equals(next) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(before + after)
  )
    return `Binary or control-character change: ${JSON.stringify(file.path)}\n`;
  const lines = (text: string) =>
    text ? (text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')) : [];
  const left = lines(before),
    right = lines(after),
    output = [`diff --git ${JSON.stringify('a/' + file.path)} ${JSON.stringify('b/' + file.path)}`];
  if (!file.before) output.push(`new file mode ${file.after?.executable ? '100755' : '100644'}`);
  if (!file.after)
    output.push(`deleted file mode ${file.before?.executable ? '100755' : '100644'}`);
  if (file.before && file.after && file.before.executable !== file.after.executable)
    output.push(
      `old mode ${file.before.executable ? '100755' : '100644'}`,
      `new mode ${file.after.executable ? '100755' : '100644'}`,
    );
  if (!left.length && !right.length) {
    if (!file.before) output.push('index 0000000..e69de29');
    if (!file.after) output.push('index e69de29..0000000');
    return output.join('\n') + '\n';
  }
  output.push(
    `--- ${file.before ? JSON.stringify('a/' + file.path) : '/dev/null'}`,
    `+++ ${file.after ? JSON.stringify('b/' + file.path) : '/dev/null'}`,
    `@@ -${left.length ? 1 : 0},${left.length} +${right.length ? 1 : 0},${right.length} @@`,
  );
  for (const line of left) output.push('-' + line);
  if (before && !before.endsWith('\n')) output.push('\\ No newline at end of file');
  for (const line of right) output.push('+' + line);
  if (after && !after.endsWith('\n')) output.push('\\ No newline at end of file');
  return output.join('\n') + '\n';
}
