"""Prepares the people's textures from MakeHuman's (CC0), as cache/textures.json (written by build.mjs) lists them,
into public/humans/ as WebP. Needs Python 3 with Pillow.

- skin: two of MakeHuman's skins in the same layout (a light and a dark one) blended to the character's tone,
  then evened toward it, with stubble where build.mjs's mask says a beard grows;
- hair, eyebrows, eyelashes: recoloured to the hair's tint keeping their strands' light and shade, the colour
  carried out under the transparent texels so the mipmaps keep no halo;
- eyes: the iris darkened to a deep Bengali brown.

    python scripts/humans/textures.py
"""

import json
import os
import random

from PIL import Image, ImageChops, ImageFilter, ImageMath

HERE = os.path.dirname(os.path.abspath(__file__))
JOBS = json.load(open(os.path.join(HERE, 'cache', 'textures.json'), encoding='utf8'))
OUT = JOBS['out']
ASSETS = JOBS['assets']
SKIN_SIZE = 1024


def to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    c = max(0.0, min(1.0, c))
    c = c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return int(round(c * 255))


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lum(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


# lookup tables between sRGB bytes and linear values
LIN = [to_linear(i) for i in range(256)]


def mean_linear(img, box):
    """Mean linear colour over a box of the texture (the chest and belly: plain skin)."""
    raw = img.crop(box).resize((64, 64)).tobytes()
    n = len(raw) // 3
    return tuple(sum(LIN[raw[i]] for i in range(k, len(raw), 3)) / n for k in range(3))


def skin(job, name):
    light = Image.open(os.path.join(ASSETS, job['light'])).convert('RGB').resize((SKIN_SIZE, SKIN_SIZE), Image.LANCZOS)
    dark = Image.open(os.path.join(ASSETS, job['dark'])).convert('RGB').resize((SKIN_SIZE, SKIN_SIZE), Image.LANCZOS)
    box = (int(SKIN_SIZE * 0.36), int(SKIN_SIZE * 0.2), int(SKIN_SIZE * 0.56), int(SKIN_SIZE * 0.42))
    ml = mean_linear(light, box)
    md = mean_linear(dark, box)
    tone = tuple(LIN[c] for c in hex_rgb(job['tone']))
    # the share of the dark skin that brings the light one's brightness to the tone's
    t = max(0.0, min(1.0, (lum(tone) - lum(ml)) / (lum(md) - lum(ml))))
    blend = Image.blend(light, dark, t)
    mb = mean_linear(blend, box)
    # then even the colour toward the tone, most of the way, so the skin keeps its own variation
    gain = [(tone[k] / mb[k]) ** 0.8 for k in range(3)]
    lut = []
    for k in range(3):
        lut += [to_srgb(LIN[i] * gain[k]) for i in range(256)]
    out = blend.point(lut)
    # stubble: the beard's shadow under the skin and its dots, darker and cooler than the skin
    strength = job.get('stubble', 0)
    if strength > 0:
        mask = Image.open(job['mask']).convert('L').resize((SKIN_SIZE, SKIN_SIZE), Image.BILINEAR).filter(ImageFilter.GaussianBlur(2))
        rnd = random.Random(7)
        dots = Image.frombytes('L', (SKIN_SIZE, SKIN_SIZE), bytes(rnd.randrange(150, 256) for _ in range(SKIN_SIZE * SKIN_SIZE)))
        amount = Image.composite(dots, Image.new('L', dots.size, 0), mask).point(lambda v: int(v * strength * 0.85))
        hair = Image.new('RGB', out.size, (34, 27, 24))
        out = Image.composite(hair, out, amount)
    out.save(os.path.join(OUT, f'{name}_skin.webp'), 'WEBP', quality=88, method=6)
    return t


def bleed(img):
    """Carries the colour of the opaque texels out under the transparent ones (blurs normalised by coverage)."""
    rgb = img.convert('RGB')
    alpha = img.split()[3]
    filled = alpha.point(lambda v: 255 if v > 0 else 0)
    out = rgb
    premult = Image.composite(rgb, Image.new('RGB', rgb.size), filled)
    for radius in (2, 6, 16, 48):
        blurred = filled.filter(ImageFilter.GaussianBlur(radius))
        cover = blurred.convert('F')
        spread = premult.filter(ImageFilter.GaussianBlur(radius))
        norm = Image.merge('RGB', [
            ImageMath.lambda_eval(lambda a: a['convert'](a['c'] * 255.0 / (a['w'] + 0.001), 'L'), c=ch.convert('F'), w=cover)
            for ch in spread.split()
        ])
        valid = blurred.point(lambda v: 255 if v > 0 else 0)
        fresh = ImageChops.multiply(valid, ImageChops.invert(filled))
        out = Image.composite(norm, out, fresh)
        filled = ImageChops.lighter(filled, valid)
        premult = Image.composite(out, Image.new('RGB', rgb.size), filled)
    return Image.merge('RGBA', (*out.split(), alpha))


def recolour(path, tint, size, name):
    img = Image.open(path).convert('RGBA').resize((size, size), Image.LANCZOS)
    r, g, b, a = img.split()
    grey = Image.merge('RGB', (r, g, b)).convert('L')
    # the strands' light and shade about their mean, on the tint
    hist = grey.histogram(a)
    n = sum(hist) or 1
    mean = sum(i * c for i, c in enumerate(hist)) / n or 1
    tr, tg, tb = hex_rgb(tint)
    rel = grey.point(lambda v: int(min(255, 128 * v / mean)))
    chans = [rel.point(lambda v, t=t: min(255, int(t * v / 128))) for t in (tr, tg, tb)]
    out = Image.merge('RGBA', (*chans, a))
    bleed(out).save(os.path.join(OUT, name), 'WEBP', quality=90, method=6)


def eyes(path):
    img = Image.open(os.path.join(ASSETS, path)).convert('RGBA').resize((512, 512), Image.LANCZOS)
    hsv = img.convert('RGB').convert('HSV')
    h, s, v = hsv.split()
    # the iris is the saturated part: darken it and turn it from red-brown to a deep brown
    iris = s.point(lambda x: 255 if x > 70 else int(x * 255 / 70) if x > 40 else 0).filter(ImageFilter.GaussianBlur(1))
    deep = Image.merge('HSV', (h.point(lambda x: 14), s.point(lambda x: min(255, int(x * 0.9))), v.point(lambda x: int(x * 0.5)))).convert('RGB')
    rgb = Image.composite(deep, img.convert('RGB'), iris)
    Image.merge('RGBA', (*rgb.split(), img.split()[3])).save(os.path.join(OUT, 'eyes.webp'), 'WEBP', quality=90, method=6)


done = set()
for name, job in JOBS['characters'].items():
    t = skin(job['skin'], name)
    recolour(job['hair']['file'], job['hair']['tint'], 1024, f'{name}_hair.webp')
    for kind, size in (('brows', 256), ('lashes', 256)):
        target = os.path.basename(os.path.dirname(job[kind])) + '.webp'
        if target in done:
            continue
        recolour(os.path.join(ASSETS, job[kind]), '#0c0908', size, target)
        done.add(target)
    if 'eyes' not in done:
        eyes(job['eyes'])
        done.add('eyes')
    print(f'{name}: skin {t:.2f} of the dark one')
