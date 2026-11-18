import { BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as yauzl from 'yauzl';
export const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export async function validateDocument(buffer: Buffer, extension: string): Promise<void> {
  if (!MIME[extension]) throw new BadRequestException('Format didukung: PDF, TXT, MD, DOCX.');
  if (!buffer.length) throw new BadRequestException('File kosong.');
  if (extension === '.pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new BadRequestException('Isi file bukan PDF valid.');
  if (extension === '.docx') await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(new BadRequestException('DOCX tidak valid.'));
      let total = 0, entries = 0, documentFound = false, ended = false;
      const fail = () => { if (ended) return; ended = true; zip.close(); reject(new BadRequestException('DOCX terlalu besar atau format tidak didukung.')); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        total += entry.uncompressedSize; entries++;
        if (total > 30 * 1024 * 1024 || entries > 2000 || entry.generalPurposeBitFlag & 1) return fail();
        if (entry.fileName === 'word/document.xml') documentFound = true;
        zip.readEntry();
      });
      zip.on('end', () => { if (ended) return; ended = true; documentFound ? resolve() : reject(new BadRequestException('File bukan DOCX.')); });
      zip.readEntry();
    });
  });
  if (extension === '.txt' || extension === '.md') {
    if (buffer.includes(0)) throw new BadRequestException('File teks mengandung data biner.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new BadRequestException('Simpan file teks menggunakan UTF-8.'); }
  }
}
export async function extractDocument(buffer: Buffer, extension: string): Promise<Array<{ page: number; text: string }>> {
  await validateDocument(buffer, extension);
  let pages: Array<{ page: number; text: string }>;
  if (extension === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      if (info.total > 200) throw new Error('PDF maksimum 200 halaman.');
      const result = await parser.getText();
      pages = result.pages.map(page => ({ page: page.num, text: page.text }));
    } finally { await parser.destroy(); }
  } else if (extension === '.docx') pages = [{ page: 1, text: (await mammoth.extractRawText({ buffer })).value }];
  else pages = [{ page: 1, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }];
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > 2_000_000) throw new Error('Teks hasil ekstraksi terlalu besar (maksimum 2 juta karakter).');
  if (!pages.some(page => page.text.trim().length > 20)) throw new Error('Tidak ada teks yang cukup untuk diindeks. PDF scan membutuhkan OCR; upload versi PDF berbasis teks.');
  return pages;
}
export function chunkPages(pages: Array<{ page: number; text: string }>) {
  const chunks: Array<{ page: number; text: string }> = [];
  for (const page of pages) {
    const text = page.text.replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 1200, text.length);
      if (end < text.length) { const boundary = text.lastIndexOf(' ', end); if (boundary > start + 700) end = boundary; }
      const part = text.slice(start, end).trim();
      if (part) chunks.push({ page: page.page, text: part });
      if (chunks.length > 2500) throw new Error('Dokumen menghasilkan terlalu banyak potongan (maksimum 2500).');
      if (end === text.length) break;
      start = end - 150;
    }
  }
  return chunks;
}
