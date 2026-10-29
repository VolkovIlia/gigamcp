#!/usr/bin/env python3
"""Сборка логотипа GigaMCP: SVG-мастера, варианты и иконки расширения.

Знак «Машиночитаемая реплика»: поисковая метка QR-кода (сетка 7 модулей, пропорции 1:1:3:1:1),
у которой есть хвостик реплики. Сообщение, которое понимает машина.

Зависимости: fonttools, cairosvg, Pillow. Шрифты: Inter Display Bold (OFL), DejaVu Sans Mono Bold.
Запуск: python3 brand/build.py
"""
import io, json, os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT_ICONS = ROOT.parent / 'extension' / 'icons'

# Палитра Сбера (по документу «Элементы фирменного стиля»)
GREEN = '#21A038'     # Зелёный Сбер — основной цвет знака
GRASS = '#00D900'     # Травяной Сбер — середина градиента
SUNNY = '#FAED00'     # Солнечный Сбер — не больше 15 % градиента
MINT = '#80F67C'      # Мятный Сбер — акцент на тёмном фоне
GRAPHITE = '#333F48'  # Графитовый Сбер — текст
SNOW = '#EEF3FF'      # Снежный Сбер — светлый фон
SIGNAL = GREEN        # основной цвет знака (одноцветные версии)
INK = GRAPHITE
PAPER = SNOW

# Линейный градиент под углом 60° (Сбер требует углы, кратные 30°): от хвостика реплики вверх вправо.
GRADIENT_ID = 'gmcpSber'
def gradient_defs(gid=GRADIENT_ID, x1=58, y1=250, x2=198, y2=8):
    return (f'<defs><linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{SUNNY}"/><stop offset="0.13" stop-color="{GRASS}"/>'
            f'<stop offset="0.55" stop-color="{GREEN}"/><stop offset="1" stop-color="{GREEN}"/></linearGradient></defs>')
FONT_HUMAN = '/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf'
FONT_MACHINE = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'


def rrect(x, y, w, h, r, cw=True):
    if r == 0:
        return f'M{x} {y} H{x+w} V{y+h} H{x} Z' if cw else f'M{x} {y} V{y+h} H{x+w} V{y} Z'
    if cw:
        return (f'M{x+r} {y} H{x+w-r} A{r} {r} 0 0 1 {x+w} {y+r} V{y+h-r} A{r} {r} 0 0 1 {x+w-r} {y+h} '
                f'H{x+r} A{r} {r} 0 0 1 {x} {y+h-r} V{y+r} A{r} {r} 0 0 1 {x+r} {y} Z')
    return (f'M{x+r} {y} A{r} {r} 0 0 0 {x} {y+r} V{y+h-r} A{r} {r} 0 0 0 {x+r} {y+h} H{x+w-r} '
            f'A{r} {r} 0 0 0 {x+w} {y+h-r} V{y+r} A{r} {r} 0 0 0 {x+w-r} {y} Z')


def mark_path(x0, y0, m, R, hole_r, center_r, ring=None, gap=None, center=None, tail=None):
    """Метка 7×7 модулей; ring/gap/center позволяют подогнать малые размеры под пиксельную сетку."""
    ring = ring or m; gap = gap or m; center = center or 3 * m
    S = 2 * ring + 2 * gap + center
    x1, y1 = x0 + S, y0 + S
    tx = tail or dict(join=56, c1=(44, 6), c2=(12, 30), tip=(-30, 36), c3=(-12, 18), c4=(0, -6), up=40)
    outer = (f'M{x0+R} {y0} H{x1-R} A{R} {R} 0 0 1 {x1} {y0+R} V{y1-R} A{R} {R} 0 0 1 {x1-R} {y1} '
             f'H{x0+tx["join"]} C{x0+tx["c1"][0]} {y1+tx["c1"][1]} {x0+tx["c2"][0]} {y1+tx["c2"][1]} {x0+tx["tip"][0]} {y1+tx["tip"][1]} '
             f'C{x0+tx["c3"][0]} {y1+tx["c3"][1]} {x0+tx["c4"][0]} {y1+tx["c4"][1]} {x0} {y1-tx["up"]} V{y0+R} A{R} {R} 0 0 1 {x0+R} {y0} Z')
    hole = rrect(x0 + ring, y0 + ring, S - 2 * ring, S - 2 * ring, hole_r, cw=False)
    core = rrect(x0 + ring + gap, y0 + ring + gap, center, center, center_r)
    return f'{outer} {hole} {core}'


# мастер 256: модуль 26, метка 182
MASTER = mark_path(52, 20, 26, 30, 14, 10)
# малые размеры — по пиксельной сетке
CUT32 = mark_path(5, 1, None, 4, 2, 1.5, ring=4, gap=4, center=10,
                  tail=dict(join=8, c1=(6, 1), c2=(3, 3.5), tip=(-3.5, 4), c3=(-1.5, 2), c4=(0, 0), up=7))
CUT16 = mark_path(3, 1, None, 2, 1, 0.5, ring=2, gap=2, center=4,
                  tail=dict(join=4, c1=(3, 0.6), c2=(1.5, 1.8), tip=(-2.2, 2.4), c3=(-0.8, 1.2), c4=(0, 0), up=3.5))


def svg(body, w, h, title='GigaMCP'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
            f'aria-label="{title}"><title>{title}</title>{body}</svg>\n')


def symbol(color, d=MASTER, size=256, gradient=False, scale=1.0):
    if gradient:
        k = scale
        defs = gradient_defs(x1=58*k, y1=250*k, x2=198*k, y2=8*k)
        return svg(f'{defs}<path fill="url(#{GRADIENT_ID})" d="{d}"/>', size, size, 'GigaMCP')
    return svg(f'<path fill="{color}" d="{d}"/>', size, size, 'GigaMCP')


def text_path(text, font, size, tracking=0):
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    f = TTFont(font); gs = f.getGlyphSet(); cmap = f.getBestCmap(); s = size / f['head'].unitsPerEm
    pen = SVGPathPen(gs); x = 0
    for ch in text:
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(pen, (s, 0, 0, -s, x * s, 0)))
        x += g.width + tracking
    return pen.getCommands(), (x - tracking) * s


def lockup(word_color, mcp_color, mark_color, gradient=False):
    # «Giga» — человеческий гротеск, «MCP» — моноширинный: разговор человека и машины
    giga, wg = text_path('Giga', FONT_HUMAN, 136)
    mcp, wm = text_path('MCP', FONT_MACHINE, 136, tracking=-60)
    x_text = 300
    x_mcp = x_text + wg + 10
    W = int(round(x_mcp + wm + 8))
    mark_fill = f'url(#{GRADIENT_ID})' if gradient else mark_color
    body = ((gradient_defs() if gradient else '') + f'<path fill="{mark_fill}" d="{MASTER}"/>'
            f'<path fill="{word_color}" transform="translate({x_text} 178)" d="{giga}"/>'
            f'<path fill="{mcp_color}" transform="translate({x_mcp:.1f} 178)" d="{mcp}"/>')
    return svg(body, W, 256, 'GigaMCP')


def write(name, text):
    (ROOT / name).write_text(text, encoding='utf-8')
    return ROOT / name


def png(svg_text, size, out, bg=None):
    import cairosvg
    from PIL import Image
    data = cairosvg.svg2png(bytestring=svg_text.encode(), output_width=size, output_height=size)
    im = Image.open(io.BytesIO(data)).convert('RGBA')
    if bg:
        base = Image.new('RGBA', im.size, bg); base.alpha_composite(im); im = base
    im.save(out)


def main():
    files = {
        'gigamcp-symbol.svg': symbol(GREEN, gradient=True),
        'gigamcp-symbol-flat.svg': symbol(GREEN),
        'gigamcp-symbol-black.svg': symbol('#000000'),
        'gigamcp-symbol-white.svg': symbol('#FFFFFF'),
        'gigamcp-symbol-32.svg': symbol(GREEN, CUT32, 32, gradient=True, scale=32/256),
        'gigamcp-symbol-16.svg': symbol(GREEN, CUT16, 16),
        'gigamcp-logo.svg': lockup(GRAPHITE, GREEN, GREEN, gradient=True),
        'gigamcp-logo-dark.svg': lockup('#FFFFFF', MINT, GREEN, gradient=True),
        'gigamcp-logo-black.svg': lockup('#000000', '#000000', '#000000'),
    }
    for k, v in files.items():
        write(k, v)
    EXT_ICONS.mkdir(parents=True, exist_ok=True)
    png(files['gigamcp-symbol-16.svg'], 16, EXT_ICONS / '16.png')
    png(files['gigamcp-symbol-32.svg'], 32, EXT_ICONS / '32.png')
    png(files['gigamcp-symbol.svg'], 48, EXT_ICONS / '48.png')
    png(files['gigamcp-symbol.svg'], 128, EXT_ICONS / '128.png')
    png(files['gigamcp-symbol.svg'], 512, ROOT / 'gigamcp-symbol-512.png')
    # путь знака 16×16 для интерфейса расширения (кнопка в giga.chat)
    (ROOT / 'ui-mark.json').write_text(json.dumps({'viewBox': '0 0 16 16', 'd': CUT16}, ensure_ascii=False))
    print('ok:', ', '.join(files))


if __name__ == '__main__':
    main()
