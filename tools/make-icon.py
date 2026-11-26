"""Make standby/public/standby.ico from assets/icon-source.png:
    python3 tools/make-icon.py
The source is the app icon on a black square; the rounded square is cut
out (outside it transparent, with smooth edges) and saved at the sizes
Windows uses (16 to 256 px). Needs Pillow; run it only when the source
changes (the .ico is committed, so builds do not need Pillow).
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'assets', 'icon-source.png')
OUT = os.path.join(HERE, '..', 'standby', 'public', 'standby.ico')
# The rounded square in the 1254 px source, measured: its edges and the
# corner radius.
LEFT, TOP, RIGHT, BOTTOM, RADIUS = 66, 78, 1188, 1174, 200
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

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
