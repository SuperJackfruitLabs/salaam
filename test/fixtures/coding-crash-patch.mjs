import { Store } from '../../dist/src/store.js';
import { Artifacts } from '../../dist/src/artifacts.js';
import { Workspaces, readTree } from '../../dist/src/workspaces.js';
import { digest } from '../../dist/src/protocol.js';
import { join } from 'node:path';
const [state, root, session] = process.argv.slice(2),
  store = new Store(join(state, 'journal.sqlite'));
const workspaces = new Workspaces(store, new Artifacts(join(state, 'artifacts'), store), root),
  w = workspaces.get(session),
  tree = readTree(w.root);
workspaces.reconcile = () => process.kill(process.pid, 'SIGKILL');
workspaces.patch(session, 'crash-proof', {
  path: 'math.js',
  expected_revision: w.revision,
  expected_hash: digest(tree['math.js']),
  content: 'export const add = (a, b) => a + b;\n',
});
throw Error('Crash boundary was not reached');
