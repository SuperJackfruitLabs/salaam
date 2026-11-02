import { expect, test } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { imagesInPrompt, readClipboardImage } from '../../src/tui/clipboard-image.js';
import { imageMime } from '../../src/runtime/mentions.js';

// Ctrl+V reads an image from the system clipboard, because a terminal pastes only text.

/** A valid RGB PNG of noise, which does not compress: about 3 bytes a pixel. */
function noisePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const small = noisePng(4, 4);

test('a clipboard image becomes base64 with its real type', async () => {
  const image = await readClipboardImage({ read: async () => small });
  expect(image).toEqual({ mime: 'image/png', data: small.toString('base64') });
});

test('no image on the clipboard is null, and a non-image is refused with a reason', async () => {
  expect(await readClipboardImage({ read: async () => null })).toBeNull();
  expect(await readClipboardImage({ read: async () => new Uint8Array() })).toBeNull();
  await expect(
    readClipboardImage({ read: async () => Buffer.from('BM-not-supported') }),
  ).rejects.toThrow('not PNG, JPEG, GIF or WebP');
});

test('Linux reads Wayland first, then X11, choosing an image type the clipboard offers', async () => {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('--list-types')) return Buffer.from('text/plain\nimage/png\n');
    if (args.includes('TARGETS')) return Buffer.from('UTF8_STRING\nimage/jpeg\n');
    return small;
  };
  const wayland = await readClipboardImage({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    exec,
  });
  expect(wayland?.mime).toBe('image/png');
  expect(calls).toEqual(['wl-paste --list-types', 'wl-paste --type image/png --no-newline']);
  calls.length = 0;
  await readClipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, exec });
  expect(calls).toEqual([
    'xclip -selection clipboard -t TARGETS -o',
    'xclip -selection clipboard -t image/jpeg -o',
  ]);
  calls.length = 0;
  const text = await readClipboardImage({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return Buffer.from('text/plain\n');
    },
  });
  expect(text).toBeNull();
  expect(calls).toEqual(['wl-paste --list-types']);
});

// Every host runs this: macOS scales with its own sips; elsewhere a large paste is refused.
test('a paste past the limit is scaled down on macOS, refused elsewhere', async () => {
  const large = noisePng(2000, 2000);
  expect(large.length).toBeGreaterThan(3_750_000);
  if (process.platform === 'darwin') {
    const image = await readClipboardImage({ platform: 'darwin', read: async () => large });
    const bytes = Buffer.from(image!.data, 'base64');
    // Noise does not compress, so this one ends as JPEG; a screenshot stays PNG.
    expect(['image/png', 'image/jpeg']).toContain(imageMime(bytes));
    expect(image!.mime).toBe(imageMime(bytes));
    expect(bytes.length).toBeLessThanOrEqual(3_750_000);
  } else {
    await expect(
      readClipboardImage({ platform: 'darwin', read: async () => large }),
    ).rejects.toThrow('the limit is 3.75 MB');
  }
  await expect(readClipboardImage({ platform: 'linux', read: async () => large })).rejects.toThrow(
    'Crop it or save a smaller one',
  );
}, 30000);

test('a prompt sends the images its markers still name, in order, once each', () => {
  const pasted = new Map([
    [1, { mime: 'image/png', data: 'AA==' }],
    [2, { mime: 'image/jpeg', data: 'BB==' }],
  ]);
  expect(imagesInPrompt('see [image #2] and [image #1] and [image #2]', pasted)).toEqual([
    { label: 'image #2', mime: 'image/jpeg', data: 'BB==' },
    { label: 'image #1', mime: 'image/png', data: 'AA==' },
  ]);
  // A marker with no pasted image (typed, or recalled from history) is only text.
  expect(imagesInPrompt('old [image #9]', pasted)).toEqual([]);
  const five = new Map([1, 2, 3, 4, 5].map((n) => [n, { mime: 'image/png', data: 'AA==' }]));
  expect(() => imagesInPrompt('[image #1][image #2][image #3][image #4][image #5]', five)).toThrow(
    'at most 4 images',
  );
});
