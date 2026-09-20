"""Give every bundled font a zero-width glyph for U+FEFF.

Belt and braces for the shaping fix in `server.js`. If libass ever falls back
to its simple shaper, FriBidi rewrites the Arabic into presentation forms and
writes U+FEFF (FRIBIDI_CHAR_FILL) into the slot the lam-alef ligature consumed.
Of the fonts bundled here only Noto Naskh and Dubai carry that codepoint, so on
every other font the filler is drawn as .notdef: a box immediately before every
لا, in text that was clean canonical Arabic the whole way down.

The filler is meant to be invisible, so an empty outline with a zero advance is
exactly right, and it is inert under complex shaping because HarfBuzz never
asks for U+FEFF in the first place.

This does not close the other half of simple shaping — the isolated forms Cairo,
Almarai and Dubai are missing (ﺍ ﺃ ﺭ ﻱ ﺓ) would still box. Mapping those onto
the glyphs each font already carries means walking GSUB per feature, which is
only worth writing if /health reports libass cannot do complex shaping.

Usage: patch-fonts.py <directory of .ttf/.otf>
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph

FILL = 0xFEFF
GLYPH_NAME = "uniFEFF"


def patch(path: Path) -> str:
    font = TTFont(path)

    if FILL in font.getBestCmap():
        return "already has U+FEFF"
    if "glyf" not in font:
        # Nothing bundled is CFF today; a CFF font needs an endchar charstring
        # rather than an empty Glyph, so say so instead of writing a broken one.
        return "skipped: not a TrueType outline font"

    order = list(font.getGlyphOrder())
    if GLYPH_NAME not in order:
        # Appended, never inserted: every existing glyph id stays where GSUB
        # and GPOS expect it.
        order.append(GLYPH_NAME)
        font.setGlyphOrder(order)
        font["glyf"].glyphs[GLYPH_NAME] = Glyph()
        font["glyf"].glyphOrder = order
        font["hmtx"].metrics[GLYPH_NAME] = (0, 0)
        font["maxp"].numGlyphs = len(order)

    mapped = 0
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[FILL] = GLYPH_NAME
            mapped += 1
    if not mapped:
        return "skipped: no Unicode cmap subtable"

    font.save(path)
    return f"added U+FEFF to {mapped} cmap subtable(s)"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2

    root = Path(argv[1])
    files = sorted(p for p in root.iterdir() if p.suffix.lower() in (".ttf", ".otf"))
    if not files:
        print(f"no fonts found in {root}", file=sys.stderr)
        return 1

    for path in files:
        try:
            print(f"{path.name}: {patch(path)}")
        except Exception as err:  # a broken font must not fail the image build
            print(f"{path.name}: left alone, {type(err).__name__}: {err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
