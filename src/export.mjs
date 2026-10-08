import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

// Retains the original image-to-A4 export approach, without course naming or global state.
export async function buildPdf(runDir, results) {
  const pdf = await PDFDocument.create();
  const width = 595.28;
  const height = 841.89;
  const files = [];
  for (const result of results) {
    for (const capture of [result, ...(result.states ?? [])]) {
      if (!capture.screenshot) continue;
      if (capture.artifacts?.length) files.push(...capture.artifacts.map(artifact => `screenshots/${artifact.file}`));
      else files.push(capture.screenshot);
    }
  }
  for (const file of [...new Set(files)]) {
    const input = path.join(runDir, file);
    const meta = await sharp(input).metadata();
    const step = Math.max(1, Math.floor(meta.width * height / width));
    for (let top = 0; top < meta.height; top += step) {
      const sliceHeight = Math.min(step, meta.height - top);
      const bytes = await sharp(input).extract({ left: 0, top, width: meta.width, height: sliceHeight }).png().toBuffer();
      const image = await pdf.embedPng(bytes);
      const scaledHeight = width * sliceHeight / meta.width;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: height - scaledHeight, width, height: scaledHeight });
    }
  }
  if (!pdf.getPageCount()) return null;
  await fs.writeFile(path.join(runDir, 'archive.pdf'), await pdf.save());
  return 'archive.pdf';
}
