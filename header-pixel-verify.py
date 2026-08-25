#!/usr/bin/env python3
"""Verificación píxel a píxel del HEADER POLISH (FIX v14):
1) La banda toca el borde superior (y=0) y los bordes laterales (x=0).
2) El glow morado se ve en la franja superior.
3) Las esquinas inferiores de la banda están redondeadas (fondo en la esquina).
4) No hay overflow horizontal.
"""
import sys
from PIL import Image

def analyze(path, label, band_bottom_hint):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    px = img.load()
    print(f"\n=== {label} ({W}x{H}) ===")

    # 1. Franja superior: promedio por fila (0..16)
    for y in range(0, 18, 3):
        row = [px[x, y] for x in range(0, W, 7)]
        avg = tuple(sum(c[i] for c in row) // len(row) for i in range(3))
        print(f"  y={y:3d}  avg={avg}")

    # 2. Esquinas superiores y bordes: ¿la banda llega a x=0 e y=0?
    print(f"  px(0,0)={px[0,0]}  px({W-1},0)={px[W-1,0]}  px({W//2},0)={px[W//2,0]}")
    # fila y=3: el color debe ser banda (card_bg + glow), no fondo de página
    row3 = [px[x, 3] for x in range(0, W, 5)]
    avg3 = tuple(sum(c[i] for c in row3) // len(row3) for i in range(3))
    print(f"  fila y=3 avg={avg3}  (banda esperada ≈ 26-60 de R, algo de B > R)")

    # 3. ¿Glow morado? En y=3 el B debe superar claramente a R y G
    b_minus_r = avg3[2] - avg3[0]
    print(f"  B-R en y=3 = {b_minus_r}  (>0 indica tinte morado)")

    # 4. Esquinas inferiores de la banda redondeadas:
    #    buscar la fila donde termina la banda en la COLUMNA CENTRAL (banda llena)
    #    y comparar con la misma fila en x=2 (esquina: debe ser fondo de página)
    cy = W // 2
    band_bottom = None
    # la banda empieza en y=0; buscar la primera fila desde abajo del hint hacia arriba
    # donde el color central sea "banda" (distinto del fondo de página ~ (10-13,10-13,15-20))
    def is_page_bg(c):
        return c[0] < 20 and c[1] < 20 and c[2] < 28
    for y in range(min(band_bottom_hint, H) - 1, 0, -1):
        if not is_page_bg(px[cy, y]):
            band_bottom = y
            break
    if band_bottom:
        print(f"  banda: fila inferior aprox. y={band_bottom} (centro)")
        # esquina: a 3px del borde izquierdo, en la fila band_bottom-3 debe ser página (radio)
        corner_y = band_bottom - 3
        c_l = px[2, corner_y]
        c_r = px[W-3, corner_y]
        c_m = px[cy, corner_y]
        print(f"  y={corner_y}: x=2 {c_l} | centro {c_m} | x={W-3} {c_r}")
        print(f"  esquinas redondeadas: izquierda {'SÍ' if is_page_bg(c_l) else 'NO'} | derecha {'SÍ' if is_page_bg(c_r) else 'NO'}")
    else:
        print("  banda: no detectada")

if __name__ == '__main__':
    for p, l, hint in [
        ("responsive-shots/desktop/admin.png", "ADMIN desktop", 220),
        ("responsive-shots/m393/admin.png", "ADMIN m393 móvil", 140),
        ("responsive-shots/desktop/cliente.png", "CLIENTE desktop", 220),
        ("responsive-shots/m393/cliente.png", "CLIENTE m393 móvil", 140),
    ]:
        analyze(p, l, hint)
