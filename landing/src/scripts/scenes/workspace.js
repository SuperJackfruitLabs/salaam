// "What it's like to use": the bench with your checkout on the left, the service in the middle with
// its own workspace tray on top (a copy of the project, which the worker edits), and the approval
// inbox on the right. The one movement is the patch leaving the workspace for the inbox, where it
// waits: the inbox's flag lights. The checkout is never touched, because nothing is applied until
// you approve, and this scene stops before that.
import { Group } from 'three';
import { box, mat } from './kit.js';
import { clamp, smooth } from './common.js';
import { AMBER, CREAM, OFF, bench, glow, service } from './bench.js';

function tray(root, x, y, z, color) {
  const g = new Group();
  g.position.set(x, y, z);
  const m = mat(color);
  box(0.62, 0.03, 0.46, m, 0, 0.015, 0, g);
  for (const s of [-1, 1]) box(0.03, 0.08, 0.46, m, s * 0.31, 0.04, 0, g);
  box(0.62, 0.08, 0.03, m, 0, 0.04, -0.23, g);
  root.add(g);
  return g;
}
/** A stack of `n` sheets: the project's files. */
function stack(parent, n, color) {
  for (let i = 0; i < n; i++)
    box(0.5, 0.014, 0.36, mat(color), (i % 2) * 0.012 - 0.006, 0.04 + i * 0.016, 0, parent);
}

export default {
  view: { look: [0.05, 0.9, 0.12], dist: 6.7, rise: 0.42, yaw: -0.2, aspect: 4 / 3, fov: 28 },
  shadow: { left: -2.6, right: 2.6, top: 2.4, bottom: -1.4 },
  beats: 1,
  build(scene, { accent, night }) {
    const root = new Group();
    scene.add(root);
    const bt = bench(root);
    const sv = service(root, bt, accent, 0, -0.2);
    glow(sv.light, accent, 0.7 + 0.4 * night);
    sv.card.visible = false;

    // Your checkout, and the workspace copy the service owns, on the service's top.
    stack(tray(root, -1.12, bt, 0.12, '#7d6a60'), 6, '#d9e0ea');
    const ws = tray(root, 0, sv.top, sv.z, '#5d4f55');
    stack(ws, 6, '#d9e0ea');
    // The approval inbox, with its flag down until something waits in it.
    const inbox = tray(root, 1.12, bt, 0.12, '#7d6a60');
    box(0.025, 0.42, 0.025, mat('#5d4f55'), 0.28, 0.21, -0.2, inbox);
    const flag = box(0.2, 0.13, 0.014, mat(OFF, true), 0.18, 0.35, -0.2, inbox);
    flag.castShadow = false;

    // The patch: one sheet with an accent edge, lifted off the workspace stack.
    const patch = new Group();
    box(0.5, 0.014, 0.36, mat(CREAM), 0, 0, 0, patch);
    const edge = box(0.5, 0.016, 0.04, mat('#ffffff', true), 0, 0.001, 0.17, patch);
    glow(edge.material, accent, 0.45);
    root.add(patch);
    const a = { x: 0, y: sv.top + 0.04 + 6 * 0.016 + 0.01, z: sv.z },
      b = { x: 1.12, y: bt + 0.05, z: 0.12 };

    return {
      set(_beat, t) {
        const p = smooth(clamp(t / 0.8));
        patch.position.set(
          a.x + (b.x - a.x) * p,
          a.y + (b.y - a.y) * p + Math.sin(p * Math.PI) * 0.32,
          a.z + (b.z - a.z) * p,
        );
        patch.rotation.z = -Math.sin(p * Math.PI) * 0.12;
        const waiting = t >= 0.85;
        glow(flag.material, waiting ? AMBER : OFF, waiting ? 0.6 + 0.3 * night : 0);
      },
    };
  },
};
