import { NextRequest } from 'next/server';
import { parseFile } from '@/lib/datasets/parse';
import { buildSnapshot } from '@/lib/datasets/normalize';
import { previewRows } from '@/lib/datasets/query';
import { LIMITS, UploadError, describeLimits } from '@/lib/datasets/limits';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Upload endpoint: bytes in, a normalised dataset snapshot out.
 *
 * Nothing is stored. The snapshot is returned to the browser, which holds it
 * for the session and sends it back with each question — so uploaded business
 * data never rests on a server, and no storage credential is needed.
 *
 * GET and DELETE deliberately do not exist. With the browser holding the
 * datasets, listing and removing them are client-side operations; server
 * endpoints for them would be dead code pretending to be an API.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: 'That upload could not be read. Please try the file again.' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ error: 'No file was attached.' }, { status: 400 });
  }

  const blob = file as File;
  if (blob.size > LIMITS.fileBytes) {
    return Response.json(
      {
        error: `That file is ${(blob.size / (1024 * 1024)).toFixed(1)} MB, above the ${describeLimits().maxFileMb} MB limit.`,
      },
      { status: 413 },
    );
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const grid = parseFile(blob.name, bytes);
    const id = `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const snapshot = buildSnapshot(grid, blob.name, id);

    return Response.json(
      { snapshot, preview: previewRows(snapshot) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    // UploadError messages are written for the person who chose the file.
    if (err instanceof UploadError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    // Anything else is ours, not theirs — say so without leaking internals.
    return Response.json(
      { error: 'Skylark could not read that file. Try exporting it as CSV or XLSX.' },
      { status: 500 },
    );
  }
}
