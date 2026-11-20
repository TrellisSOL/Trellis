import HomeNav from '../components/landing/HomeNav';
import Hero from '../components/Hero';
import Landing, { HomeFooter } from '../components/Landing';
import styles from '../components/Landing.module.css';

export default function Home(){return <div className={`garden ${styles.site}`}><HomeNav/><main id="content" data-i18n><Hero/><Landing/></main><HomeFooter/></div>}
