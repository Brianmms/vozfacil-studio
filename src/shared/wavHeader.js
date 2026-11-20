/**
 * Repairs RIFF and `data` chunk sizes in streamed WAV payloads where encoders
 * write `0xFFFFFFFF` placeholders. Works identically in browsers and Node.js.
 */
export function fixWavHeaderBytes(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('fixWavHeaderBytes requires a Uint8Array');
  }
  if (input.byteLength < 44) {
    return input;
  }

  const readAscii = (bytes, offset) =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );

  if (readAscii(input, 0) !== 'RIFF' || readAscii(input, 8) !== 'WAVE') {
    return input;
  }

  const out = new Uint8Array(input);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  const expectedRiffSize = out.byteLength - 8;
  const currentRiffSize = view.getUint32(4, true);
  if (currentRiffSize === 0xffffffff || currentRiffSize !== expectedRiffSize) {
    view.setUint32(4, expectedRiffSize, true);
  }

  let offset = 12;
  while (offset + 8 <= out.byteLength) {
    const chunkId = readAscii(out, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (chunkId === 'data') {
      const actualDataSize = out.byteLength - dataStart;
      if (chunkSize === 0xffffffff || chunkSize > actualDataSize) {
        view.setUint32(offset + 4, actualDataSize, true);
      }
      break;
    }

    if (chunkSize === 0xffffffff || dataStart + chunkSize > out.byteLength) {
      break;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return out;
}
