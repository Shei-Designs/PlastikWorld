// A button that opens a panel beneath it, closed by a click elsewhere or Escape.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function Popover({ button, children, align = 'left', className }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div ref={host} className={`popover${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <span onClick={() => setOpen((o) => !o)} style={{ display: 'contents' }}>
        {button(open)}
      </span>
      {open && <div className={`popover-panel ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
