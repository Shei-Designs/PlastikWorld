import type { ReactNode, SVGProps } from 'react';

const Icon = ({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

/** The product tile, as the favicon and the in-app logo. */
export const Logo = () => <img src="/icon.svg" width="22" height="22" alt="" />;

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Icon>
);
export const FitIcon = () => (
  <Icon>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
);
export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Icon>
);
export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Icon>
);
export const DuplicateIcon = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </Icon>
);
export const GridIcon = () => (
  <Icon>
    <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
  </Icon>
);
export const CubeIcon = () => (
  <Icon>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
  </Icon>
);
export const RobotIcon = () => (
  <Icon>
    <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
    <path d="M12 8V5.5" />
    <circle cx="12" cy="4" r="1.5" />
    <path d="M9 13h.01M15 13h.01" strokeWidth="2.6" />
    <path d="M9.5 16.5h5" />
  </Icon>
);
export const LightIcon = () => (
  <Icon>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
  </Icon>
);
export const FlagIcon = () => (
  <Icon>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </Icon>
);
export const TerrainIcon = () => (
  <Icon>
    <path d="M3 18 9 8l4 6 2-3 6 7z" />
    <path d="M3 21h18" />
  </Icon>
);
export const WorldIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
);
export const ImportIcon = () => (
  <Icon>
    <path d="M12 3v12M7 10l5 5 5-5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Icon>
);
export const ExportIcon = () => (
  <Icon>
    <path d="M12 15V3M7 8l5-5 5 5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const LibraryIcon = () => (
  <Icon>
    <path d="M4 5h5v14H4zM11 5h5v14h-5z" />
    <path d="M17.5 6.2l3.6-1 3.3 12.6-3.6 1z" transform="translate(-2.4 0)" />
  </Icon>
);
export const SlidersIcon = () => (
  <Icon>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8M4 12h2M10 12h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
    <circle cx="8" cy="12" r="2" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const WarningIcon = () => (
  <Icon>
    <path d="M12 3 2 20h20z" />
    <path d="M12 9v5M12 17h.01" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 4 4L19 6" />
  </Icon>
);
export const ChevronIcon = () => (
  <Icon>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const PinIcon = () => (
  <Icon>
    <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
    <circle cx="12" cy="10" r="2.2" />
  </Icon>
);
