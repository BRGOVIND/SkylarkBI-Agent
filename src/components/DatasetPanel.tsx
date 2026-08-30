'use client';

import { useCallback, useId, useRef, useState } from 'react';
import type { CellValue, DatasetSnapshot } from '@/lib/datasets/types';

/**
 * Bringing your own data into the workspace.
 *
 * Uploads are parsed on the server and come back as a compact snapshot the
 * browser holds for the session. Nothing is stored anywhere: close the tab and
 * the data is gone. That is stated in the UI rather than left to be discovered.
 */

export interface LoadedDataset {
  snapshot: DatasetSnapshot;
  preview: Array<Record<string, CellValue>>;
}

type Phase = 'idle' | 'reading' | 'understanding';

const ACCEPT = '.csv,.tsv,.xlsx,.xls,.ods';

const fmt = (n: number) => n.toLocaleString();

export default function DatasetPanel({
  datasets,
  onAdd,
  onRemove,
  disabled,
  max,
}: {
  datasets: LoadedDataset[];
  onAdd: (d: LoadedDataset) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
  max: number;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const full = datasets.length >= max;
  const busy = phase !== 'idle';

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setPhase('reading');
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await fetch('/api/datasets', { method: 'POST', body });

        setPhase('understanding');
        const json = await res.json().catch(() => null);

        if (!res.ok || !json?.snapshot) {
          setError(json?.error ?? 'Skylark could not read that file.');
          return;
        }
        onAdd({ snapshot: json.snapshot, preview: json.preview ?? [] });
      } catch {
        setError('The upload did not complete. Check your connection and try again.');
      } finally {
        setPhase('idle');
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [onAdd],
  );

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f && !full && !disabled) void upload(f);
  };

  return (
    <section className="datasets" aria-labelledby={`${inputId}-h`}>
      <div className="datasets-head">
        <h3 id={`${inputId}-h`}>Your data</h3>
        <span className="datasets-note">
          {datasets.length ? `${datasets.length} of ${max} loaded · this session only` : 'Optional'}
        </span>
      </div>

      {datasets.map(({ snapshot: s, preview }) => {
        const open = openId === s.id;
        return (
          <article className="ds-card" key={s.id}>
            <div className="ds-top">
              <div className="ds-id">
                <span className="ds-name">{s.name}</span>
                <span className="ds-meta">
                  {fmt(s.rowCount)} rows · {s.columns.length} columns
                  {s.sheetName && ` · sheet “${s.sheetName}”`}
                </span>
              </div>
              <button
                className="linkish"
                onClick={() => onRemove(s.id)}
                disabled={disabled}
                aria-label={`Remove ${s.name}`}
              >
                Remove
              </button>
            </div>

            <div className="ds-cols">
              {s.columns.slice(0, 8).map((c) => (
                <span className="ds-col" key={c.key} title={`${c.type} · ${c.completeness}% populated`}>
                  {c.name}
                  <i>{c.type}</i>
                </span>
              ))}
              {s.columns.length > 8 && (
                <span className="ds-col ds-col-more">+{s.columns.length - 8} more</span>
              )}
            </div>

            {!!s.quality.warnings.length && (
              <p className="ds-warn">{s.quality.warnings[0]}</p>
            )}

            <button
              className="rail-summary"
              onClick={() => setOpenId(open ? null : s.id)}
              aria-expanded={open}
            >
              <svg className="chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M3 1 L7 5 L3 9" stroke="currentColor" strokeWidth="1.4" fill="none" />
              </svg>
              {open ? 'Hide' : 'What Skylark read'}
            </button>

            {open && (
              <div className="table-wrap ds-preview" tabIndex={0} role="group" aria-label={`Preview of ${s.name}`}>
                <table>
                  <thead>
                    <tr>
                      {s.columns.map((c) => (
                        <th key={c.key}>
                          {c.name}
                          <em>{c.type}</em>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i}>
                        {s.columns.map((c) => {
                          const v = row[c.name];
                          return (
                            <td key={c.key} className={v === null ? 'ds-null' : undefined}>
                              {v === null ? '—' : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        );
      })}

      {!full && (
        <div
          className={`dropzone${dragging ? ' over' : ''}${busy ? ' busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy && !disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) pick(e.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPT}
            className="visually-hidden"
            onChange={(e) => pick(e.target.files)}
            disabled={busy || disabled}
          />
          <label htmlFor={inputId} className="dropzone-label">
            {busy ? (
              <span className="dz-busy" role="status" aria-live="polite">
                <span className="dz-spark" aria-hidden="true" />
                {phase === 'reading' ? 'Reading your data' : 'Understanding the columns'}
              </span>
            ) : (
              <>
                <span className="dz-title">Drop a spreadsheet, or choose a file</span>
                <span className="dz-hint">CSV · TSV · XLSX · XLS · ODS</span>
              </>
            )}
          </label>
        </div>
      )}

      {full && (
        <p className="datasets-note">
          {max} datasets loaded. Remove one to add another.
        </p>
      )}

      {error && (
        <p className="ds-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
