// iPhone launch screens (portrait): CSS size × pixel ratio, one PNG each under /pwa/splash/. iOS picks the image whose
// media query matches the device; without one it shows a blank screen while the page loads.
export const SPLASH_SCREENS = [
  [440, 956, 3, 'iPhone 16 Pro Max'],
  [402, 874, 3, 'iPhone 16 Pro'],
  [430, 932, 3, 'iPhone 14 Pro Max – 16 Plus'],
  [393, 852, 3, 'iPhone 14 Pro – 16'],
  [428, 926, 3, 'iPhone 12 Pro Max – 14 Plus'],
  [390, 844, 3, 'iPhone 12 – 14'],
  [375, 812, 3, 'iPhone X – 13 mini'],
  [414, 896, 3, 'iPhone XS Max, 11 Pro Max'],
  [414, 896, 2, 'iPhone XR, 11'],
  [375, 667, 2, 'iPhone SE, 8'],
].map(([width, height, ratio, name]) => ({ width, height, ratio, name, file: `launch-${width * ratio}x${height * ratio}.png` }));

export const splashMedia = ({ width, height, ratio }) =>
  `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`;

export const startupImages = () => SPLASH_SCREENS.map((s) => ({ url: `/pwa/splash/${s.file}`, media: splashMedia(s) }));
