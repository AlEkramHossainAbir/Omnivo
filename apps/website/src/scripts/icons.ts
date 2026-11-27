// HugeIcons data (from @hugeicons/core-free-icons) is a list of SVG elements: [tag, attributes].
// The package's own IconSvgObject type is not exported from its index, so this is the same shape,
// read-only, written once here. Every icon of the package is assignable to it.
export type IconData = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

// The package writes attribute names in React's camelCase (strokeLinecap). Plain SVG needs
// kebab-case (stroke-linecap), or the browser ignores the attribute.
const kebab = (name: string): string => name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

// Attribute values come from the icon package, not from a visitor, but escaping them costs
// nothing and keeps this safe if a caller ever passes other data.
const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The icon as an SVG string, for Astro's set:html. Stroke Rounded, 1.5px, currentColor, so the
// icon takes the text color of its parent (CLAUDE.md rule 4).
export function iconSvg(icon: IconData, size: number): string {
  const children = icon
    .map(([tag, attrs]) => {
      const list = Object.entries(attrs)
        // "key" is React's list key, not an SVG attribute
        .filter(([name]) => name !== 'key')
        .map(([name, value]) => `${kebab(name)}="${escape(String(value))}"`)
        .join(' ');
      return `<${tag} ${list}/>`;
    })
    .join('');
  return (
    `<svg class="ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${String(size)}" ` +
    `height="${String(size)}" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`
  );
}
