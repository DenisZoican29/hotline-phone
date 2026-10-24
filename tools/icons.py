# Draws the home-screen icon (an answering machine on a neon Miami sky).
#   python tools/icons.py
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw():
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    top, bottom = (40, 6, 70), (255, 40, 140)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(top, bottom, (y / S) ** 1.6))
    # sunset stripes
    for i, y in enumerate(range(700, S, 46)):
        d.rectangle([0, y, S, y + 10 + i * 3], fill=(40, 6, 70))

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rounded_rectangle([150, 300, 874, 760], 70, fill=(0, 255, 255, 170))
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    img.paste(glow, (0, 0), glow)

    d = ImageDraw.Draw(img)
    # machine body
    d.rounded_rectangle([170, 320, 854, 740], 60, fill=(222, 208, 180), outline=(60, 40, 40), width=10)
    d.rounded_rectangle([170, 600, 854, 740], 60, fill=(196, 180, 150))
    d.rectangle([180, 600, 844, 640], fill=(196, 180, 150))
    # cassette window
    d.rounded_rectangle([240, 370, 784, 570], 26, fill=(30, 20, 30), outline=(60, 40, 40), width=8)
    d.rounded_rectangle([290, 400, 734, 540], 18, fill=(240, 236, 220))
    d.rectangle([290, 400, 734, 440], fill=(255, 40, 140))
    for cx in (400, 624):
        d.ellipse([cx - 52, 440, cx + 52, 544], fill=(30, 20, 30))
        d.ellipse([cx - 22, 470, cx + 22, 514], fill=(240, 236, 220))
        for k in range(6):
            a = k * math.pi / 3
            d.line([(cx, 492), (cx + 20 * math.cos(a), 492 + 20 * math.sin(a))], fill=(30, 20, 30), width=6)
    # buttons + LED
    for i, x in enumerate(range(250, 640, 100)):
        d.rounded_rectangle([x, 640, x + 80, 700], 12, fill=(60, 50, 60))
    d.ellipse([690, 636, 770, 716], fill=(255, 30, 40), outline=(120, 0, 10), width=6)
    led = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(led).ellipse([670, 616, 790, 736], fill=(255, 60, 60, 140))
    led = led.filter(ImageFilter.GaussianBlur(18))
    img.paste(led, (0, 0), led)
    return img


OUT.mkdir(parents=True, exist_ok=True)
img = draw()
for size, name in [(1024, "icon-1024.png"), (512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name)
    print("wrote", name)
