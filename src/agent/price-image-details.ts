import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Overlapping detail views keep narrow merged-cell borders legible to the image reader. */
export async function priceImageDetails(url: string): Promise<unknown[]> {
  const encoded = url.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)?.[1];
  if (!encoded) return [];
  try {
    const image = await loadImage(Buffer.from(encoded, 'base64'));
    if (image.width < 600 || image.height < 600 || image.width * image.height > 20_000_000) return [];
    const parts: unknown[] = [];
    for (const [label, x, y, width, height] of [
      ['kiri atas', 0, 0, 0.53, 0.7], ['kiri bawah', 0, 0.3, 0.53, 0.7],
      ['kanan atas', 0.47, 0, 0.53, 0.7], ['kanan bawah', 0.47, 0.3, 0.53, 0.7],
    ] as const) {
      const sourceWidth = Math.round(image.width * width), sourceHeight = Math.round(image.height * height);
      const outputWidth = 1400, outputHeight = Math.round(sourceHeight * outputWidth / sourceWidth);
      const canvas = createCanvas(outputWidth, outputHeight);
      canvas.getContext('2d').drawImage(image, Math.round(image.width * x), Math.round(image.height * y), sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
      const buffer = await canvas.encode('jpeg', 88);
      parts.push({ type: 'text', text: `Detail ${label} dari gambar yang SAMA; area saling tumpang tindih. Ini bukan tabel/batch baru. Gunakan garis batas sel yang tampak pada detail.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'high' } });
    }
    return parts;
  } catch { return []; }
}
