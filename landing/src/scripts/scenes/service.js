// "How it works", one beat per step. On the bench: the service in the middle, a terminal on the
// left and a laptop (an editor, or a terminal over SSH) on the right, each with a cable to it.
//   1. Start the local service: its light comes on and a session card rises from its slot.
//   2. Attach the terminal: the terminal's cable lights from the terminal to the service, and its
//      screen fills in.
//   3. Detach and come back: the terminal's cable goes dark and its screen empties, while the
//      session card stays where it is; then the laptop's cable lights and its screen fills in with
//      the same session.
import { CatmullRomCurve3, Group, Mesh, TubeGeometry, Vector3 } from 'three';
import { box, mat } from './kit.js';
import { clamp, smooth } from './common.js';
import { OFF, bench, glow, screen, service } from './bench.js';

const SEG = 48,
  RADIAL = 6,
  PER = RADIAL * 6;

function cable(root, pts, accent) {
  const path = new CatmullRomCurve3(pts.map((p) => new Vector3(...p)));
  root.add(new Mesh(new TubeGeometry(path, SEG, 0.016, RADIAL), mat('#4a3c41')));
  const lit = new Mesh(new TubeGeometry(path, SEG, 0.02, RADIAL), mat('#ffffff', true));
  glow(lit.material, accent, 0.5);
  lit.castShadow = false;
  root.add(lit);
  // Lit from the client's end, `k` of the way (0 to 1); `from` > 0 darkens it from that end again.
  return (k, from = 0) =>
    lit.geometry.setDrawRange(Math.round(from * SEG) * PER, Math.round((k - from) * SEG) * PER);
}

export default {
  view: { look: [0.05, 0.9, 0.1], dist: 6.7, rise: 0.36, yaw: -0.22, aspect: 4 / 3, fov: 28 },
  shadow: { left: -2.6, right: 2.6, top: 2.4, bottom: -1.4 },
  beats: 3,
  build(scene, { accent, night }) {
    const root = new Group();
    scene.add(root);
    const bt = bench(root);
    const sv = service(root, bt, accent);
    const shell = mat('#5d4f55'),
      lid = mat('#9a8f94');

    // The terminal: a monitor on a foot, turned a little towards the service.
    const term = new Group();
    term.position.set(-1.12, bt, 0.18);
    term.rotation.y = 0.42;
    box(0.26, 0.03, 0.18, shell, 0, 0.015, 0, term);
    box(0.05, 0.2, 0.05, shell, 0, 0.13, -0.03, term);
    box(0.66, 0.46, 0.07, shell, 0, 0.45, 0, term);
    const tScreen = new Group();
    tScreen.position.set(0, 0.45, 0.037);
    term.add(tScreen);
    root.add(term);
    const termScreen = screen(tScreen, 0.58, 0.38, accent);

    // The laptop: open, turned towards the service from the other side.
    const lap = new Group();
    lap.position.set(1.12, bt, 0.22);
    lap.rotation.y = -0.42;
    box(0.56, 0.025, 0.38, lid, 0, 0.0125, 0, lap);
    const hinge = new Group();
    hinge.position.set(0, 0.025, -0.19);
    hinge.rotation.x = -0.3;
    box(0.56, 0.38, 0.02, lid, 0, 0.19, 0, hinge);
    const lScreen = new Group();
    lScreen.position.set(0, 0.19, 0.012);
    hinge.add(lScreen);
    lap.add(hinge);
    root.add(lap);
    const lapScreen = screen(lScreen, 0.5, 0.32, accent);

    // The cables, along the bench from each client to the service's sides.
    const y = bt + 0.02,
      sx = sv.W / 2 + 0.02;
    const termCable = cable(
      root,
      [
        [-1.18, y, -0.02],
        [-0.9, y, -0.2],
        [-0.6, y, -0.18],
        [-sx, bt + 0.12, -0.2],
      ],
      accent,
    );
    const lapCable = cable(
      root,
      [
        [1.2, y, 0.0],
        [0.9, y, -0.2],
        [0.6, y, -0.18],
        [sx, bt + 0.12, -0.2],
      ],
      accent,
    );
    const lit = 0.7 + 0.4 * night;

    return {
      set(beat, t) {
        const b = (k) => (k < beat ? 1 : k > beat ? 0 : t);
        // 1: the service starts, and the session card rises.
        const up = smooth(b(1));
        glow(sv.light, up > 0.05 ? accent : OFF, up > 0.05 ? lit : 0);
        sv.card.position.y = sv.down + (sv.up - sv.down) * up;
        // 2: the terminal attaches.
        const attach = smooth(clamp(b(2) / 0.8));
        // 3: it detaches (first half), and the laptop attaches (second half).
        const leave = smooth(clamp(b(3) / 0.4)),
          come = smooth(clamp((b(3) - 0.5) / 0.4));
        termCable(attach, beat === 3 ? leave : 0);
        termScreen.set(beat === 3 ? (leave < 1 ? 1 - leave : 0) : b(2) >= 0.8 || beat > 2 ? 1 : 0);
        lapCable(come);
        lapScreen.set(come >= 1 ? 1 : 0);
      },
    };
  },
};
