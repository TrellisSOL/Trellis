import { createElement as h } from 'react';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import { groupOf, groupSections } from './account-state.js';
import { enabled, extraAttr } from '../../lib/launch-surface.js';
// A plain click on a dashboard section stays on the page; modified clicks and other pages follow the link.
const follow = (section, onNavigate) => event => {
  if (!onNavigate || !section.hash || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); onNavigate(section.title);
};
// U104: the five account tabs. Real links, so they also work from /agents/ and /dashboard/webhooks/; each opens its first section.
// `surface` is the router's launch surface ('core', 'all' or unknown, lib/launch-surface.js). In core a tab opens its first
// core section and only core sections are listed; before the router has answered the others are only marked, for the stylesheet.
const offered = (group, surface) => groupSections(group).filter(section => enabled('section', section.taskId, surface));
const marked = (section, surface) => (surface === 'all' ? {} : extraAttr('section', section.taskId));
export function AccountTabs({ current, onNavigate, className, surface }) {
  const here = groupOf(current);
  return h('nav', { className: 'dashboard-nav' + (className ? ' ' + className : ''), 'aria-label': 'Account' }, ACCOUNT_GROUPS.map(group => {
    const first = offered(group, surface)[0] || groupSections(group)[0];
    return h('a', { key: group.id, href: first.href, 'aria-current': group === here ? 'true' : undefined, onClick: follow(first, onNavigate) }, group.title);
  }));
}
// The sections of the current tab.
export function AccountNavigation({ current, onNavigate, surface }) {
  const group = groupOf(current);
  return h('nav', { 'aria-label': `${group.title} sections` }, h('div', null,
    h('span', { className: 'eyebrow' }, group.title),
    ...offered(group, surface).map(section => h('a', { key: section.taskId, href: section.href, ...marked(section, surface), 'aria-current': current === section.title ? 'page' : undefined, onClick: follow(section, onNavigate) }, section.title))));
}
// What signed-out visitors see on Home: the six things it shows once a key is connected. No numbers.
// The third entry names the non-core part a card belongs to (lib/launch-surface.js): a core router's Home leaves it out.
export const HOME_PREVIEW = [
  ['Balance', 'What you can spend, and how to add funds.'],
  ['Spending', 'Today and this week, in USDC.', 'spend'],
  ['Keys', 'Your API keys and what each one can do.'],
  ['Agents', 'Each agent and its budget, and any you have stopped.', 'agents'],
  ['Waiting for you', 'Agent payments that need your approval.', 'agents'],
  ['Recent calls', 'Your last five calls, each with its signed receipt.'],
];
// A section description that names something a core router does not serve, as a core router's page words it.
export const CORE_COPY = {
  dashboard: 'See your balance, keys and recent call receipts in one place.',
  settings: 'Read how to connect an app, and sign out of this browser.',
};
export function AccountPreview({ current, children }) {
  const section = ACCOUNT_SECTIONS.find(item => item.title === current) || ACCOUNT_SECTIONS[0];
  return h('section', { className: 'control-panel', 'aria-labelledby': 'account-preview-title' },
    h('span', { className: 'eyebrow' }, 'Your account'), h('h2', { id: 'account-preview-title', tabIndex: -1 }, section.title),
    CORE_COPY[section.taskId] ? h('p', { 'data-surface-extra': '' }, section.description) : h('p', null, section.description),
    CORE_COPY[section.taskId] ? h('p', { 'data-surface-core': '' }, CORE_COPY[section.taskId]) : null,
    h('p', { className: 'help-text' }, section.start),
    section.title === 'Home' ? h('div', { className: 'account-preview-grid', 'aria-label': 'What your Home shows' },
      HOME_PREVIEW.map(([title, text, part]) => h('div', { key: title, ...(part ? extraAttr('part', part) : {}) }, h('strong', null, title), h('span', null, text)))) : null,
    children);
}
