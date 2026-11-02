// Runs as the tools user: applies reviewed local edits that the service has recorded and verified.
import { closeSync, constants, fsyncSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyLocalEdits, localPath, verifyLocalEdits } from './edits.js';
import type { ToolEdit } from './tool-identity.js';

const root = process.argv[2];
if (!root) throw new Error('usage: local-edit-helper <root>');
const edits = JSON.parse(readFileSync(0, 'utf8')) as ToolEdit[];
for (const { remove, ...edit } of edits) {
  if (remove) {
    verifyLocalEdits(root, [edit]);
    const path = localPath(root, edit.path);
    rmSync(path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    process.stdout.write('applied ' + JSON.stringify(edit.path) + '\n');
  } else
    applyLocalEdits(root, [edit], (path) =>
      process.stdout.write('applied ' + JSON.stringify(path) + '\n'),
    );
}
