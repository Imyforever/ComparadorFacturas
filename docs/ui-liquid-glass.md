# Referencia visual: Liquid Glass claro (estilo macOS / iOS)

Objetivo: toda la interfaz (login y dashboard) con paneles de "vidrio claro esmerilado" flotando sobre la foto de paisaje a pantalla completa (`public/img/fondo-paisaje.jpg`), con texto oscuro y contraste WCAG AA.

## Fondo (rendimiento de scroll)
- `body::before` con `position: fixed; inset: 0; z-index: -1; will-change: transform;` (sin `background-attachment: fixed`) para evitar repintados durante el scroll.
- Imagen: `url('/img/fondo-paisaje.jpg')` con degradado de respaldo (cielo azul → verde lago) y velo sutil encima.
- Sin contenedor de vidrio envolvente global en el dashboard: cada sección es su propio panel sobre la foto.

## Vidrio claro esmerilado (tokens en :root)
```css
--glass-bg: rgba(255, 255, 255, 0.62);         /* paneles, tarjetas, filtros, modales */
--glass-bg-strong: rgba(255, 255, 255, 0.80);  /* tablas: más opaco para leer números */
--glass-bg-row-alt: rgba(255, 255, 255, 0.55); /* filas alternas de tabla */
--glass-bg-sticky: rgba(255, 255, 255, 0.85);  /* encabezado sticky de tabla */
--glass-border: rgba(255, 255, 255, 0.72);
--glass-border-subtle: rgba(15, 23, 42, 0.14);
--glass-blur: blur(24px) saturate(180%);
--glass-shadow: 0 8px 32px rgba(15, 23, 42, 0.12),
                inset 0 1px 0 rgba(255, 255, 255, 0.85),
                inset 0 -1px 0 rgba(255, 255, 255, 0.35);
--glass-radius: 20px;

/* Texto y colores semánticos sobre vidrio claro */
--text-main: #0f172a;
--text-muted: #334155; /* nunca más claro que #475569 */
--primary: #0f6b37;
--error: #b42318;
--info: #1d4ed8;
--warning: #92400e;
```

## Reglas de rendimiento de scroll
- `backdrop-filter` aplicado **únicamente** en paneles contenedores (`.glass`), encabezados sticky de tabla (`.table-excel th`), modales (`.modal-card`, `.modal-backdrop`) y toasts (`.toast`).
- **Sin `backdrop-filter`** en elementos repetidos (filas de tabla, items de lista, chips de estado/banco, botones repetidos).

## Verificación de contrastes (WCAG 2.1)
Sobre `--glass-bg` (`rgba(255,255,255,.62)`) encima de zonas claras (L≈0.89) y oscuras (L≈0.45), y sobre `--glass-bg-strong` (`rgba(255,255,255,.80)`, L≥0.68):
- `#0f172a` sobre `.glass` (L 0.45–0.89): **8.38:1 – 15.75:1** (AAA).
- `#334155` sobre `.glass` (L 0.45–0.89): **4.95:1 – 9.31:1** (AA/AAA).
- `#475569` sobre `.table-container` (.80, L≥0.68): **≥ 5.25:1** (AA).
- Valores en tarjetas de resumen (`16px–20px bold`, umbral AA ≥ 3.0:1 / 4.5:1 sobre claro):
  - Verde `#0f6b37`: **5.73:1** sobre claro / **3.05:1+** sobre oscuro.
  - Rojo `#b42318`: **5.73:1** sobre claro / **3.05:1+** sobre oscuro.
  - Azul `#1d4ed8`: **6.48:1** sobre claro / **3.45:1+** sobre oscuro.
  - Ámbar `#92400e`: **6.06:1** sobre claro / **3.23:1+** sobre oscuro.
- Chips con texto `#ffffff` y opacidad `≥ 0.88`:
  - Pagada (`rgba(15,107,55,.90)`): **6.40:1** (AA).
  - No Pagada (`rgba(180,35,24,.90)`): **6.40:1** (AA).
  - Cancelada (`rgba(71,85,105,.88)`): **7.55:1** (AAA).
  - Auto NC (`rgba(67,56,202,.90)`): **8.61:1** (AAA).
  - BBVA (`rgba(0,68,129,.92)`): **9.91:1** (AAA).
  - Scotiabank (`rgba(185,28,28,.92)`): **6.33:1** (AA).

## Accesibilidad y respaldos
- Foco visible (`:focus-visible`) de alto contraste (`#0f6b37` + halo blanco).
- `@media (prefers-reduced-motion: reduce)` desactiva transiciones y escalados.
- `@media (prefers-reduced-transparency: reduce)` y `@supports not (backdrop-filter)` usan fondos claros sólidos (`rgba(255,255,255,0.95)`).
- Responsivo hasta 360px de ancho.
