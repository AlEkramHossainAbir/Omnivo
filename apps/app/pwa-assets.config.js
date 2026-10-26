// Step 19a: how the app icons in public/ were made. They are committed, so the build never runs
// this. Run it again only when the logo changes:
//   pnpm dlx @vite-pwa/assets-generator@2.0.0 --manifest false
// (from apps/app). It reads favicon.svg and writes the PNGs next to it.
export default {
  images: ['public/favicon.svg'],
  preset: {
    // The logo on a clear background, for the install dialog and the desktop's app list
    transparent: { sizes: [192, 512], favicons: [] },
    // Android cuts the icon to a circle or a rounded square. Everything inside the middle 80% (a
    // circle) is kept. The logo's rounded corners reach 63% of its width from its centre, so it
    // must be at most 326 px wide on 512: padding 0.4 makes it 307 px.
    maskable: { sizes: [512], padding: 0.4, resizeOptions: { background: '#ffffff' } },
    // iOS puts its own rounded corners on a square with no see-through parts
    apple: { sizes: [180], padding: 0.3, resizeOptions: { background: '#ffffff' } },
  },
};
