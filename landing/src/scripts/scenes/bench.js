// The workbench both scenes stand on, and the pieces they share: the service, which owns the
// sessions, and the screens of the clients that attach to it.
import { Group } from 'three';
import { box, mat, plinth } from './kit.js';

export const CREAM = '#f4eee2',
  AMBER = '#e8c78c',
  OFF = '#2a2226';

/** A material that glows in `color` by `k` (0 is dark). */
export function glow(m, color, k) {
  if (color.isColor) m.color.copy(color);
  else m.color.set(color);
  m.emissive.copy(m.color).multiplyScalar(k);
}

/** The plinth and a low bench on it. Returns the bench's top. */
export function bench(root) {
  const top = plinth(4.3, 2.1, root);
  const wood = mat('#8a5a3b'),
    dark = mat('#6b4129');
  const h = 0.36,
    bt = top + h + 0.07;
  box(3.5, 0.07, 1.45, wood, 0, top + h + 0.035, 0, root);
  for (const x of [-1.62, 1.62])
    for (const z of [-0.6, 0.6]) box(0.08, h, 0.08, dark, x, top + h / 2, z, root);
  box(3.2, 0.05, 0.05, dark, 0, top + 0.08, -0.6, root);
  return bt;
}

/**
 * The service: a squat cabinet with a status light on its front and a slot in its top, from which
 * the session card rises. `x`, `z` are its centre on the bench at height `bt`.
 */
export function service(root, bt, accent, x = 0, z = -0.25) {
  const W = 0.86,
    H = 0.56,
    D = 0.52;
  box(W, H, D, mat('#3b2e33'), x, bt + H / 2, z, root);
  box(W + 0.04, 0.04, D + 0.04, mat('#2a2024'), x, bt + H + 0.02, z, root);
  box(0.56, 0.02, 0.06, mat('#120c0f'), x, bt + H + 0.041, z, root);
  const light = box(
    0.16,
    0.05,
    0.012,
    mat(OFF, true),
    x - 0.24,
    bt + H - 0.12,
    z + D / 2 + 0.006,
    root,
  );
  light.castShadow = false;
  // The session: a card that stands in the slot, its top edge in the accent.
  const card = new Group();
  box(0.5, 0.34, 0.014, mat(CREAM), 0, 0, 0, card);
  const edge = box(0.5, 0.035, 0.016, mat('#ffffff', true), 0, 0.17, 0, card);
  glow(edge.material, accent, 0.35);
  for (let i = 0; i < 3; i++)
    box(0.34 - i * 0.06, 0.016, 0.016, mat('#b9ab9d'), -0.05 - i * 0.03, 0.08 - i * 0.06, 0, card);
  card.position.set(x, bt + H + 0.04 - 0.2, z);
  root.add(card);
  return {
    light: light.material,
    card,
    down: card.position.y,
    up: card.position.y + 0.26,
    top: bt + H + 0.04,
    x,
    z,
    W,
    D,
  };
}

/** A screen with three lines of text that light when a client is attached. */
export function screen(parent, w, h, accent) {
  const face = box(w, h, 0.006, mat('#ffffff', true), 0, 0, 0, parent);
  face.castShadow = false;
  const lines = [0.62, 0.42, 0.78].map((f, i) => {
    const l = box(
      w * f,
      h * 0.07,
      0.004,
      mat('#ffffff', true),
      -w * (1 - f) * 0.4,
      h * (0.22 - i * 0.2),
      0.005,
      parent,
    );
    l.castShadow = false;
    return l.material;
  });
  return {
    set(k) {
      face.material.color.set('#1d1619');
      face.material.emissive.copy(accent).multiplyScalar(0.12 * k);
      lines.forEach((m, i) => (k ? glow(m, i === 1 ? accent : CREAM, 0.55 * k) : glow(m, OFF, 0)));
    },
  };
}
