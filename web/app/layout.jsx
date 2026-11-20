import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import './sections.css';
import './pages.css';
import './calm.css';
import './mobile.css';
import './garden.css';
import HomeScreenHint from '../components/HomeScreenHint';
import LocaleSync from '../components/i18n/LocaleSync';
import { startupImages } from '../lib/splash-screens.js';
export const metadata={title:'Trellis — Model inference on Solana',description:'Explore models, pay per call in USDC on Solana, and verify signed inference receipts.',manifest:'/manifest.webmanifest',appleWebApp:{capable:true,title:'Trellis',statusBarStyle:'black-translucent',startupImage:startupImages()},formatDetection:{telephone:false},other:{'apple-mobile-web-app-capable':'yes'},icons:{apple:'/pwa/apple-touch-icon.png',icon:[{url:'/brand/trellis-mark.svg',type:'image/svg+xml'}]}};
export const viewport={themeColor:'#f4f0e6',viewportFit:'cover'};
// The inline script marks a Home Screen launch (html[data-standalone], app/mobile.css) and, on iPhone and iPad, adds
// maximum-scale=1: iOS still lets people pinch-zoom, but stops zooming the page in when a small input is focused.
// It also applies the launch surface this tab saw last (lib/launch-surface.js HINT_KEY), so a core router's
// pages hide non-core entries before the first paint (globals.css, "launch surface"). And it applies the stored
// language (lib/i18n STORAGE_KEY): <html lang> at once, the page hidden until LocaleSync has put the text in.
export default function RootLayout({children}){return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:"var d=document.documentElement;d.classList.add('js');try{if(navigator.standalone===true||matchMedia('(display-mode: standalone)').matches)d.setAttribute('data-standalone','')}catch(e){}if(/iPad|iPhone|iPod/.test(navigator.userAgent)){var v=function(){var m=document.querySelector('meta[name=viewport]');if(m&&m.content.indexOf('maximum-scale')<0)m.content+=',maximum-scale=1'};v();document.addEventListener('DOMContentLoaded',v)}try{var s=sessionStorage.getItem('trellis-launch-surface');if(s==='core'||s==='all')document.documentElement.dataset.launchSurface=s}catch(e){}try{var l=localStorage.getItem('trellis-locale');if(l==='zh-Hans'){d.lang=l;d.dataset.locale=l;d.setAttribute('data-locale-pending','');setTimeout(function(){d.removeAttribute('data-locale-pending')},2000)}}catch(e){}"}}/></head><body>{children}<HomeScreenHint/><LocaleSync/></body></html>}
