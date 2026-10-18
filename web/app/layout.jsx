import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import './sections.css';
import './pages.css';
import './calm.css';
import './mobile.css';
import HomeScreenHint from '../components/HomeScreenHint';
import { startupImages } from '../lib/splash-screens.js';
export const metadata={title:'Trellis — Every open model. One line of code. Proof on every call.',description:'The inference router on Solana: USDC payments, signed receipts, encrypted chat, agent rulebooks and a network open for early hosts.',manifest:'/manifest.webmanifest',appleWebApp:{capable:true,title:'Trellis',statusBarStyle:'black-translucent',startupImage:startupImages()},formatDetection:{telephone:false},other:{'apple-mobile-web-app-capable':'yes'},icons:{apple:'/pwa/apple-touch-icon.png',icon:[{url:'/brand/trellis-mark.svg',type:'image/svg+xml'}]}};
export const viewport={themeColor:'#09090b',viewportFit:'cover'};
// The inline script marks a Home Screen launch (html[data-standalone], app/mobile.css) and, on iPhone and iPad, adds
// maximum-scale=1: iOS still lets people pinch-zoom, but stops zooming the page in when a small input is focused.
// It also applies the launch surface this tab saw last (lib/launch-surface.js HINT_KEY), so a core router's
// pages hide non-core entries before the first paint (globals.css, "launch surface").
export default function RootLayout({children}){return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:"var d=document.documentElement;d.classList.add('js');try{if(navigator.standalone===true||matchMedia('(display-mode: standalone)').matches)d.setAttribute('data-standalone','')}catch(e){}if(/iPad|iPhone|iPod/.test(navigator.userAgent)){var v=function(){var m=document.querySelector('meta[name=viewport]');if(m&&m.content.indexOf('maximum-scale')<0)m.content+=',maximum-scale=1'};v();document.addEventListener('DOMContentLoaded',v)}try{var s=sessionStorage.getItem('trellis-launch-surface');if(s==='core'||s==='all')document.documentElement.dataset.launchSurface=s}catch(e){}"}}/></head><body>{children}<HomeScreenHint/></body></html>}
