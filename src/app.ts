// The one place the app's name and its publisher live in the frontend.
export const APP_NAME = 'PlastikWorld';
/** The short form, for window titles and the places the full name will not fit. */
export const APP_SHORT_NAME = 'PlastikWorld';
export const APP_VERSION = '0.1.0';
/** Where the source code and license live, shown in the About box. */
export const APP_URL = 'https://github.com/Shei-Designs/PlastikWorld';
/** The app this one is the companion of: it makes the objects and robots, this one places them. */
export const COMPANION_NAME = 'PlastikCAD';
export const COMPANION_URL = 'https://github.com/Shei-Designs/PlastikCAD';
/** The brand the app is published under, and who makes it. */
export const PUBLISHER = 'Shei Designs';
export const PUBLISHER_URL = 'https://sheidesigns.com';
export const AUTHOR = 'Andrew O\'Shei';
export const AUTHOR_URL = 'https://andrewoshei.com';
/** Marker written into world files, and their extension. */
export const FILE_FORMAT = 'plastikcad-world';
export const FILE_VERSION = 1;
export const FILE_EXTENSION = 'plastikworld';
/** Whether a file name ends in the world extension. */
export const isWorldName = (name: string): boolean => /\.plastikworld$/i.test(name);
