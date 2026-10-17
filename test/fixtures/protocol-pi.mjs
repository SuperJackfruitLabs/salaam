let buffer = '';
process.stderr.write('diagnostic text is not protocol\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const index = buffer.indexOf('\n');
  if (index === -1) return;
  const request = JSON.parse(buffer.slice(0, index));
  buffer = buffer.slice(index + 1);
  if (process.env.PROTOCOL_FAULT === 'invalid') {
    process.stdout.write('not json\n');
    return;
  }
  if (process.env.PROTOCOL_FAULT === 'oversize') {
    process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
    return;
  }
  const bytes = Buffer.from(
    JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      data: { label: 'Salaam\u2028नमस्ते🌍' },
    }) + '\r\n',
  );
  const split = bytes.indexOf(Buffer.from('🌍')) + 2;
  process.stdout.write(bytes.subarray(0, split));
  setImmediate(() => process.stdout.write(bytes.subarray(split)));
});
process.stdin.on('end', () => process.exit());
