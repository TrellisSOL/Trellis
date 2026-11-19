// The dashboard as a workspace: six pages in the dock and everything else under More. Each page is a
// set of account sections (lib/site-map.js ACCOUNT_SECTIONS, by task id); the page's tabs are those sections. The five
// account groups (ACCOUNT_GROUPS) still decide the More menu's headings and every section's hash link.
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import { enabled } from '../../lib/launch-surface.js';

export const PAGES = [
  { id: 'home', label: 'Home', icon: 'home', ids: ['dashboard', 'inbox', 'account-activity', 'insights'] },
  { id: 'chat', label: 'Chat', icon: 'chat', ids: ['playground'] },
  { id: 'models', label: 'Models', icon: 'models', ids: ['models', 'providers', 'routing', 'presets', 'characters', 'evals', 'batches', 'skills'] },
  { id: 'keys', label: 'Keys', icon: 'keys', ids: ['account-keys', 'rulebook', 'playbooks', 'sessions', 'spend', 'teams', 'directory'] },
  { id: 'purse', label: 'Purse', icon: 'purse', ids: ['account-payments', 'api-receipts', 'statements'] },
  { id: 'settings', label: 'Settings', icon: 'settings', ids: ['settings', 'keep', 'webhooks', 'account-export'] },
];

/** Images and Video (update 6): pages of their own, shown in the dock once the router has released the update. */
export const MEDIA_PAGES = [
  { id: 'images', label: 'Images', href: '/images/' },
  { id: 'video', label: 'Video', href: '/video/' },
];

const byId = id => ACCOUNT_SECTIONS.find(section => section.taskId === id);
/** The sections of a page that this router offers (all of them until the router has said it runs the core surface). */
export const pageSections = (page, surface) => page.ids.map(byId).filter(section => section && enabled('section', section.taskId, surface));
/** The page a section belongs to (Home when unknown). */
export const pageOf = title => PAGES.find(page => page.ids.some(id => byId(id)?.title === title)) || PAGES[0];
/** The More menu: every offered section, under its account group's title. */
export const moreGroups = surface => ACCOUNT_GROUPS.map(group => ({ title: group.title, sections: group.ids.map(byId).filter(section => section && enabled('section', section.taskId, surface)) })).filter(group => group.sections.length);
/** The page title: the page's own name for the dock pages, the section's title inside them. */
export const isChat = title => pageOf(title).id === 'chat';
