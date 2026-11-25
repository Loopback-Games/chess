// 16×16 pixel-art chess pieces, drawn as text grids.
//   o = outline, f = fill (auto-shaded: left edge highlighted, right edge shadowed), . = transparent
// Rendered to crisp SVG data URIs so they scale cleanly at any board size.

const GRIDS = {
  p: [
    '................',
    '................',
    '................',
    '......oooo......',
    '.....offffo.....',
    '.....offffo.....',
    '......offo......',
    '.....offffo.....',
    '......offo......',
    '......offo......',
    '.....offffo.....',
    '....offffffo....',
    '...offffffffo...',
    '...offffffffo...',
    '...oooooooooo...',
    '................',
  ],
  r: [
    '................',
    '................',
    '..ooo.oooo.ooo..',
    '..ofo.offo.ofo..',
    '..ofoooffooofo..',
    '..offffffffffo..',
    '...offffffffo...',
    '....offffffo....',
    '....offffffo....',
    '....offffffo....',
    '....offffffo....',
    '...offffffffo...',
    '..offffffffffo..',
    '..offffffffffo..',
    '..oooooooooooo..',
    '................',
  ],
  n: [
    '................',
    '.......o.o......',
    '......ofofo.....',
    '.....offffoo....',
    '....offoffffo...',
    '...offffffffo...',
    '..offffffffffo..',
    '..ofoooffffffo..',
    '...o..offffffo..',
    '.....offffffo...',
    '....offffffo....',
    '....offffffo....',
    '...offffffffo...',
    '..offffffffffo..',
    '..oooooooooooo..',
    '................',
  ],
  b: [
    '................',
    '.......oo.......',
    '......offo......',
    '.....offofo.....',
    '.....ofoffo.....',
    '.....offffo.....',
    '......offo......',
    '.....offffo.....',
    '......offo......',
    '......offo......',
    '.....offffo.....',
    '....offffffo....',
    '...offffffffo...',
    '..offffffffffo..',
    '..oooooooooooo..',
    '................',
  ],
  q: [
    '................',
    '.oo...oooo...oo.',
    '.ofo..offo..ofo.',
    '.offo.offo.offo.',
    '..offoffffoffo..',
    '..offffffffffo..',
    '...offffffffo...',
    '....offffffo....',
    '.....offffo.....',
    '.....offffo.....',
    '....offffffo....',
    '....offffffo....',
    '...offffffffo...',
    '..offffffffffo..',
    '..oooooooooooo..',
    '................',
  ],
  k: [
    '......oooo......',
    '......offo......',
    '....oooffooo....',
    '....offffffo....',
    '....oooffooo....',
    '......offo......',
    '...ooooffoooo...',
    '..offffffffffo..',
    '..offffffffffo..',
    '...offffffffo...',
    '....offffffo....',
    '....offffffo....',
    '...offffffffo...',
    '..offffffffffo..',
    '..oooooooooooo..',
    '................',
  ],
};

// Brand palette (from the Loopback Games logo).
export const PALETTE = {
  w: { o: '#101015', f: '#eef1ff', h: '#ffffff', s: '#53d9e4' },
  b: { o: '#d223d0', f: '#1d1433', h: '#9846e3', s: '#0e0a1a' },
};

/** Grid -> SVG markup. One <rect> per horizontal run of same-colored pixels. */
export function pieceSvg(type, color) {
  const pal = PALETTE[color];
  const rects = [];
  GRIDS[type].forEach((row, y) => {
    // Shade: first fill pixel after the left outline = highlight, last before right outline = shadow.
    const cells = [...row].map((ch, x) => {
      if (ch !== 'f') return ch;
      if (row[x - 1] === 'o') return 'h';
      if (row[x + 1] === 'o') return 's';
      return 'f';
    });
    let x = 0;
    while (x < 16) {
      const ch = cells[x];
      let end = x + 1;
      while (end < 16 && cells[end] === ch) end++;
      if (ch !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${pal[ch]}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

export const pieceUri = (type, color) => `url("data:image/svg+xml,${encodeURIComponent(pieceSvg(type, color))}")`;

/** CSS class for a piece sprite, e.g. "pc-wq". (Plain "b" would clash: black vs bishop.) */
export const pieceClass = (type, color) => `pc-${color}${type}`;

/** Inject one CSS rule per piece so elements only need `class="piece pc-wq"`. */
export function installPieceStyles() {
  const css = [];
  for (const color of ['w', 'b']) for (const type of Object.keys(GRIDS)) css.push(`.${pieceClass(type, color)}{background-image:${pieceUri(type, color)}}`);
  const style = document.createElement('style');
  style.textContent = css.join('\n');
  document.head.appendChild(style);
}

export const GRID_SIZE = 16;
export { GRIDS };
