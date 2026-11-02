// The parts library: the generic pieces of a world, by category, each drawn
// small from its default numbers; one tap adds it to the world at the origin.
import { useEffect, useMemo, useRef, useState } from 'react';
import { addPart, showLibrary, useEditor } from '../state/store';
import { PARTS, buildPart } from '../parts/library';
import type { PartCategory, PartDef } from '../parts/library';
import { thumbnailOf } from '../viewer/thumbnail';

const CATEGORIES: { id: PartCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'structure', label: 'Structure' },
  { id: 'indoor', label: 'Indoor' },
  { id: 'outdoor', label: 'Outdoor' },
  { id: 'road', label: 'Roads' },
];

function Card({ def }: { def: PartDef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // Drawn once the card is on screen, so opening the library does not draw twenty parts at once.
    const watch = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watch.disconnect();
      const { merged } = buildPart(def, {});
      thumbnailOf(merged, el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [def]);
  return (
    <button type="button" className="part-card" onClick={() => addPart(def.id)}>
      <canvas ref={canvas} width={192} height={120} aria-hidden="true" />
      <span className="name">{def.name}</span>
      <span className="blurb">{def.blurb}</span>
    </button>
  );
}

export function LibraryDialog() {
  const open = useEditor((s) => s.library);
  const dialog = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<PartCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PARTS.filter((p) => (category === 'all' || p.category === category) && (!q || p.name.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q)));
  }, [category, search]);
  return (
    <dialog
      ref={dialog}
      className="sheet wide"
      aria-label="Parts library"
      onCancel={(e) => {
        e.preventDefault();
        showLibrary(false);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) showLibrary(false);
      }}
    >
      {open && (
        <div className="sheet-body">
          <h1>Parts</h1>
          <p>Walls, ramps, roads, furniture and the rest, each made from a few numbers you can change once it is placed. A part goes in at the origin; drag it where it belongs.</p>
          <div className="library-cats">
            <div className="segmented small" role="group" aria-label="Category">
              {CATEGORIES.map((c) => (
                <button key={c.id} type="button" className={category === c.id ? 'on' : ''} onClick={() => setCategory(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <input className="text-input" type="search" placeholder="Search…" aria-label="Search the parts" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="library-grid">
            {shown.map((def) => (
              <Card key={def.id} def={def} />
            ))}
            {shown.length === 0 && <p>Nothing by that name.</p>}
          </div>
          <div className="sheet-buttons">
            <button type="button" className="primary" onClick={() => showLibrary(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
