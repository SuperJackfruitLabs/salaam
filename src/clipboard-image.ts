import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNativeClipboard } from '@earendil-works/pi-tui';
import { imageMime, MAX_IMAGES, PASTED_IMAGE_LIMIT } from './mentions.js';

/**
 * An image pasted into the composer with Ctrl+V. The terminal only pastes text, so the TUI reads
 * the system clipboard itself: Pi's native helper on macOS and Windows, wl-paste or xclip on
 * Linux. The image travels with its prompt, in the durable outbox, never as a file in the project.
 */

/** The longest side a large paste is scaled to on macOS, the size providers resize to anyway. */
const SCALE_TO = 1568;

export interface PastedImage {
  mime: string;
  /** base64 */
  data: string;
}

type Run = (cmd: string, args: string[]) => Promise<Buffer | undefined>;

const run: Run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(
      cmd,
      args,
      { encoding: 'buffer', timeout: 3000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    ),
  );

async function linuxImage(env: NodeJS.ProcessEnv, exec: Run): Promise<Buffer | null> {
  const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (env.WAYLAND_DISPLAY) {
    const list = await exec('wl-paste', ['--list-types']);
    if (list) {
      const type = types.find((t) => list.toString().split('\n').includes(t));
      return type ? ((await exec('wl-paste', ['--type', type, '--no-newline'])) ?? null) : null;
    }
  }
  if (env.DISPLAY) {
    const list = await exec('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
    if (list) {
      const type = types.find((t) => list.toString().split('\n').includes(t));
      return type
        ? ((await exec('xclip', ['-selection', 'clipboard', '-t', type, '-o'])) ?? null)
        : null;
    }
  }
  const native = await getNativeClipboard()?.getImage();
  return native?.length ? Buffer.from(native) : null;
}

/**
 * Fit an image under the limit with macOS's own `sips`: scale its longest side to SCALE_TO as PNG,
 * and if that is still too large (a photo), as JPEG.
 */
async function scaleDown(bytes: Buffer, exec: Run): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), 'salaam-paste-'));
  try {
    const input = join(dir, 'in');
    writeFileSync(input, bytes, { mode: 0o600 });
    let out: Buffer | null = null;
    for (const format of ['png', 'jpeg']) {
      const output = join(dir, 'out.' + format);
      const done = await exec('/usr/bin/sips', [
        '--resampleHeightWidthMax',
        String(SCALE_TO),
        '-s',
        'format',
        format,
        ...(format === 'jpeg' ? ['-s', 'formatOptions', '80'] : []),
        input,
        '--out',
        output,
      ]);
      if (!done) return out;
      out = readFileSync(output);
      if (out.length <= PASTED_IMAGE_LIMIT) return out;
    }
    return out;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The image on the clipboard, ready to send, or null when the clipboard holds no image. Throws
 * with a plain reason when there is one that cannot be sent.
 */
export async function readClipboardImage(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exec?: Run;
    read?: () => Promise<Uint8Array | null | undefined>;
  } = {},
): Promise<PastedImage | null> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  let bytes: Buffer | null;
  if (options.read) {
    const got = await options.read();
    bytes = got?.length ? Buffer.from(got) : null;
  } else if (platform === 'linux') bytes = await linuxImage(options.env ?? process.env, exec);
  else {
    const got = await getNativeClipboard()?.getImage();
    bytes = got?.length ? Buffer.from(got) : null;
  }
  if (!bytes) return null;
  if (bytes.length > PASTED_IMAGE_LIMIT && platform === 'darwin')
    bytes = (await scaleDown(bytes, exec)) ?? bytes;
  const mime = imageMime(bytes);
  if (!mime) throw new Error('The clipboard image is not PNG, JPEG, GIF or WebP.');
  if (bytes.length > PASTED_IMAGE_LIMIT)
    throw new Error(
      `The clipboard image is ${(bytes.length / 1e6).toFixed(1)} MB; the limit is ${PASTED_IMAGE_LIMIT / 1e6} MB. Crop it or save a smaller one.`,
    );
  return { mime, data: bytes.toString('base64') };
}

/** The short hash shown beside a pasted image, as attached files show theirs. */
export function imageDigest(image: PastedImage): string {
  return createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex').slice(0, 12);
}

/**
 * The pasted images a prompt still mentions, in the order their markers appear. A marker the user
 * deleted sends nothing; a marker typed by hand, or recalled from history, has no image and is text.
 */
export function imagesInPrompt(
  text: string,
  pasted: ReadonlyMap<number, PastedImage>,
): { label: string; mime: string; data: string }[] {
  const seen = new Set<number>();
  const out: { label: string; mime: string; data: string }[] = [];
  for (const m of text.matchAll(/\[image #(\d{1,4})\]/g)) {
    const n = Number(m[1]);
    const image = pasted.get(n);
    if (!image || seen.has(n)) continue;
    seen.add(n);
    out.push({ label: `image #${n}`, mime: image.mime, data: image.data });
  }
  if (out.length > MAX_IMAGES)
    throw new Error(`A message can carry at most ${MAX_IMAGES} images; remove a marker.`);
  return out;
}
