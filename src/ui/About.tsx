// The About box: name, version and license, opened from the file menu.
import { useEffect, useRef } from 'react';
import type React from 'react';
import { APP_NAME, APP_URL, APP_VERSION, AUTHOR, AUTHOR_URL, COMPANION_NAME, COMPANION_URL, PUBLISHER, PUBLISHER_URL } from '../app';
import { openUrl } from '../platform';
import { Logo } from './icons';

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function About({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label={`About ${APP_NAME}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-body about-body">
        <div className="brand">
          <Logo />
          <span className="wordmark">{APP_NAME}</span>
        </div>
        <p>Version {APP_VERSION}</p>
        <p className="about-by">
          A <Link href={PUBLISHER_URL}>{PUBLISHER}</Link> project, designed and built by <Link href={AUTHOR_URL}>{AUTHOR}</Link>.
        </p>
        <p>
          The companion of <Link href={COMPANION_URL}>{COMPANION_NAME}</Link>: it makes the objects and robots, this app places them in a world and writes the scene for Gazebo, MuJoCo and Isaac Sim.
        </p>
        <p>Free software under the GNU General Public License, version 3 or later.</p>
        <p>
          <Link href={APP_URL}>{APP_URL}</Link>
        </p>
        <div className="sheet-buttons">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
