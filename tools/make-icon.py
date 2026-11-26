"""Make the app icons from assets/icon-source.png:
    python3 tools/make-icon.py
- standby/public/standby.ico: the rounded square cut out (outside it
  transparent, with smooth edges) at the sizes Windows uses (16 to 256 px).
- umbrel-official/icon.png: a plain 512 px square for the official Umbrel
  App Store, which rounds icons itself; the corners are filled with the
  icon's own background.
The source is the app icon on a black square. Needs Pillow; run it only
when the source changes (both files are committed, so builds do not need
Pillow).
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'assets', 'icon-source.png')
OUT = os.path.join(HERE, '..', 'standby', 'public', 'standby.ico')
UMBREL_OUT = os.path.join(HERE, '..', 'umbrel-official', 'icon.png')
# The rounded square in the 1254 px source, measured: its edges and the
# corner radius.
LEFT, TOP, RIGHT, BOTTOM, RADIUS = 66, 78, 1188, 1174, 200
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
# The rounded square's background: near black, about 10 at the top
# fading to 5 at the bottom.
FILL_TOP, FILL_BOTTOM = 10, 5

src = Image.open(SRC).convert('RGBA').crop((LEFT, TOP, RIGHT, BOTTOM))
w, h = src.size
side = max(w, h)
# A rounded-rectangle mask drawn 4x larger, then shrunk: smooth edges.
big = Image.new('L', (w * 4, h * 4), 0)
ImageDraw.Draw(big).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), radius=RADIUS * 4, fill=255)
src.putalpha(big.resize((w, h), Image.LANCZOS))
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(src, ((side - w) // 2, (side - h) // 2), src)
square.resize((256, 256), Image.LANCZOS).save(OUT, format='ICO', sizes=[(s, s) for s in SIZES])
print('wrote', os.path.relpath(OUT), 'sizes', SIZES)

# The rounded square's own edge blends into the black around it; a mask
# a little inside that edge keeps only the background, so no ring shows.
INSET = 16
inner = Image.open(SRC).convert('RGBA').crop((LEFT, TOP, RIGHT, BOTTOM))
big = Image.new('L', (w * 4, h * 4), 0)
ImageDraw.Draw(big).rounded_rectangle((INSET * 4, INSET * 4, (w - INSET) * 4 - 1, (h - INSET) * 4 - 1), radius=(RADIUS - INSET) * 4, fill=255)
inner.putalpha(big.resize((w, h), Image.LANCZOS))
# The corners take the background's own top-to-bottom gradient.
plain = Image.new('RGBA', (side, side))
plain.putdata([(v, v, v, 255) for y in range(side) for v in [round(FILL_TOP + (FILL_BOTTOM - FILL_TOP) * y / (side - 1))] for _ in range(side)])
plain.paste(inner, ((side - w) // 2, (side - h) // 2), inner)
os.makedirs(os.path.dirname(UMBREL_OUT), exist_ok=True)
plain.convert('RGB').resize((512, 512), Image.LANCZOS).save(UMBREL_OUT, format='PNG', optimize=True)
print('wrote', os.path.relpath(UMBREL_OUT), '512 px')
