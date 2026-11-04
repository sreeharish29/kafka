/* =====================================================================
   grid.ts — the grid. Edit BOXES to put a box in any cell.

   Every grid cell looks like this (px, y grows downward):

        +-----------------+ - - - - - +
        |                 |   gutter  |   <- wire channel on the right
        |    where the    |   (GUT_X) |
        |    box sits     |           |
        |   (BOX_W x BOX_H)           |
        +-----------------+ - - - - - +
        |  gutter (GUT_Y) : wire channel below
        +- - - - - - - - -+ - - - - - +

   The board also has one gutter of padding on its top and left, so
   every box is surrounded by channels and wires can go all the way
   around the outside.

   Wires are routed on a finer square grid (RES px). The centre line of
   every channel falls on a routing-cell centre, which keeps wires
   centred between boxes. Keep (GUT_X / 2) % RES === RES / 2 (same for
   GUT_Y) when you change sizes; checkGridAlignment() warns in dev.
   ===================================================================== */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const COLS = 4;
export const ROWS = 3;

export const BOX_W = 200;
export const BOX_H = 110;
export const GUT_X = 70; // wire channel width between columns
export const GUT_Y = 70; // wire channel height between rows

export const CELL_W = BOX_W + GUT_X;
export const CELL_H = BOX_H + GUT_Y;

export const BOARD_W = GUT_X + COLS * CELL_W;
export const BOARD_H = GUT_Y + ROWS * CELL_H;

export const RES = 10; // routing cell size
export const CLEAR = 16; // keep-out margin around every box
export const STUB = Math.min(GUT_X, GUT_Y) / 2; // straight run out of a box = middle of the channel

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/** Unit vector pointing out of a box through each side. */
export const OUT: Record<Side, { dx: number; dy: number }> = {
  top: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  bottom: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
};

export type BoxDef = {
  id: string;
  col: number; // 0 .. COLS-1
  row: number; // 0 .. ROWS-1
  tag: string;
  label: string;
  sub: string;
};

/** Put a box in any cell by giving it a col and a row. */
export const BOXES: BoxDef[] = [
  { id: 'inbox', col: 0, row: 0, tag: 'source', label: 'Inbox', sub: '612 messages waiting' },
  { id: 'phish', col: 2, row: 0, tag: 'check', label: 'Phishing check', sub: 'score 0.97, high risk' },
  { id: 'quarantine', col: 3, row: 0, tag: 'action', label: 'Quarantine', sub: 'move to the quarantine folder' },
  { id: 'classify', col: 1, row: 1, tag: 'filter', label: 'Classify', sub: 'choice, folder, risk score' },
  { id: 'archive', col: 0, row: 2, tag: 'action', label: 'Archive', sub: 'file as read' },
  { id: 'draft', col: 2, row: 2, tag: 'action', label: 'Draft reply', sub: 'LLM writes a short reply' },
  { id: 'calendar', col: 3, row: 2, tag: 'action', label: 'Calendar', sub: 'create an event' },
];

export const boxRect = (b: { col: number; row: number }): Rect => ({
  x: GUT_X + b.col * CELL_W,
  y: GUT_Y + b.row * CELL_H,
  w: BOX_W,
  h: BOX_H,
});

/** Centre lines of the wire channels (for the grid overlay). */
export const LANES_X = Array.from({ length: COLS + 1 }, (_, k) => GUT_X / 2 + k * CELL_W);
export const LANES_Y = Array.from({ length: ROWS + 1 }, (_, k) => GUT_Y / 2 + k * CELL_H);

export const SLOTS = Array.from({ length: ROWS * COLS }, (_, i) => ({
  col: i % COLS,
  row: Math.floor(i / COLS),
}));

/** Board px (origin top-left, y down) -> R3F world (origin centre, y up). */
export const toWorld = (p: Pt): [number, number, number] => [p.x - BOARD_W / 2, BOARD_H / 2 - p.y, 0];

export function checkGridAlignment() {
  const ok = (GUT_X / 2) % RES === RES / 2 && (GUT_Y / 2) % RES === RES / 2 && BOX_H / 2 % RES === RES / 2;
  if (!ok) {
    console.warn(
      '[a3] Channel centres are not on routing-cell centres. Keep (GUT / 2) % RES === RES / 2 for wires to centre in channels.',
    );
  }
}
