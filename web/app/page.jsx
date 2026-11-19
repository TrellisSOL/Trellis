import '@fontsource-variable/fraunces/full.css';
import './garden.css';
import HomeNav from '../components/landing/HomeNav';
import Hero from '../components/Hero';
import Landing, { HomeFooter } from '../components/Landing';
import styles from '../components/Landing.module.css';

// The homepage has its own frame (a bar over the night hero, the sections and a closing footer) on the light Garden
// system (app/garden.css). The rest of the site keeps PageFrame. The long-form tour lives on /how-it-works/.
export default function Home(){return <div className={`garden ${styles.site}`}><HomeNav/><main id="content"><Hero/><Landing/></main><HomeFooter/></div>}
