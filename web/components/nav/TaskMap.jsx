import { GROUPS, TASKS } from '../../lib/site-map';
import { enabled, extraAttr } from '../../lib/launch-surface.js';
import SearchButton from './SearchButton';
import './nav.css';

// Launch surface: non-core cards and entries are marked; the stylesheet hides them when the router reports `core`.
const featured = group => TASKS.filter(task => task.group === group.id && task.featured);
export default function TaskMap() {
  return <section className="task-map section" aria-labelledby="task-map-title"><div className="container">
    <div className="section-head"><div><span className="eyebrow tick">Find your next step</span><h2 id="task-map-title">What do you want to do?</h2></div><SearchButton homepage /></div>
    <div className="task-map-grid">{GROUPS.map(group => <div className="task-map-card" key={group.id} {...(featured(group).some(task => enabled('nav', task.id, 'core')) ? {} : { 'data-surface-extra': '' })}><h3>{group.title}</h3><ul>{featured(group).map(task => <li key={task.id} {...extraAttr('nav', task.id)}><a href={task.href} {...extraAttr('nav', task.id)}><strong>{task.title}<b aria-hidden="true">↗</b></strong><span>{task.description}</span></a></li>)}</ul></div>)}</div>
  </div></section>;
}
