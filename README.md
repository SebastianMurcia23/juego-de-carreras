# 🏎️ Road Rumble

Juego de carreras con armas, 100% web, multijugador, inspirado en AirConsole.  
**El celular es el volante.** El computador muestra la carrera.

---

## Inicio rápido (local)

```bash
npm install
npm start
# → http://localhost:3000
```

Para que el giroscopio del celular funcione **necesitas HTTPS**.  
Usa un túnel en local:

### Opción A: cloudflared
```bash
# Instala cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel --url http://localhost:3000
# Te da una URL pública, e.g. https://xxxx.trycloudflare.com
BASE_URL=https://xxxx.trycloudflare.com npm start
```

### Opción B: ngrok
```bash
# Instala ngrok: https://ngrok.com/download
ngrok http 3000
# Te da una URL pública, e.g. https://xxxx.ngrok-free.app
BASE_URL=https://xxxx.ngrok-free.app npm start
```

> **⚠️ Importante:** configura `BASE_URL` con la URL pública para que los QR apunten a la dirección correcta desde el celular.

---

## Variables de entorno

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `PORT`   | Puerto del servidor | `3000` |
| `BASE_URL` | URL pública (para QR en celular) | Detectada automáticamente |
| `PAYMENT_PROVIDER` | Proveedor de pagos que habilitará checkout real | Sin configurar |

## Base de producto y monetización

El proyecto incluye una primera capa de producto preparada para crecer sin
convertir las compras en ventajas competitivas:

- Perfil por dispositivo con nivel, XP, monedas y estadísticas.
- Catálogo de cosméticos, inventario y compra con moneda del juego.
- Temporada con recompensas gratuitas/premium y misiones configurables.
- Clasificación global basada en XP.
- PWA instalable con manifest y service worker.
- API preparada para integrar un proveedor de pagos.

Endpoints disponibles:

```text
GET  /api/product/catalog
POST /api/product/profile
GET  /api/product/profile/:id
POST /api/product/purchase
GET  /api/product/leaderboard
POST /api/product/checkout
```

`/api/product/checkout` devuelve `501` hasta configurar un proveedor de pagos
real y sus credenciales en el servidor. No se deben aceptar pagos reales con
el almacenamiento en memoria actual: para producción hay que añadir una base
de datos, autenticación de cuenta, webhooks firmados, idempotencia y
verificación antifraude.

---

## Despliegue en Render / Railway

### Render
1. Crea un nuevo **Web Service** apuntando a este repositorio.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment: `NODE_ENV=production`
5. La URL pública de Render ya es HTTPS — no necesitas `BASE_URL`.

### Railway
1. Crea un nuevo proyecto desde GitHub.
2. Railway detecta el `package.json` automáticamente.
3. Variables: `PORT` se inyecta sola; `NODE_ENV=production`.

---

## Estructura del proyecto

```
/
├── server/
│   ├── index.js          ← Entry point (Express + Socket.IO)
│   └── RoomManager.js    ← Salas, tokens, QR, reconexión
├── client/
│   ├── index.html        ← Pantalla del anfitrión (/)
│   ├── join.html         ← Pantalla del jugador invitado (/join/:code)
│   ├── controller.html   ← Control del celular (/control/:token)
│   ├── css/style.css
│   └── js/
│       ├── main.js       ← Lógica del anfitrión
│       ├── player.js     ← Lógica del jugador
│       └── controller.js ← Lógica del celular (gyro, botones)
├── shared/
│   └── constants.js      ← Eventos y constantes compartidos
├── config/               ← (Etapa 2+) carros, armas, pistas, puntuación
└── package.json
```

---

## Flujo de juego (Etapa 1)

1. **Anfitrión** entra a `/` → "Crear sala como administrador"
2. El servidor crea una sala con código de 4 letras y un **token secreto** guardado en el navegador.
3. El anfitrión ve **su QR** (para su celular) y el **enlace de invitación**.
4. El anfitrión escanea su QR con su celular → escribe su nombre → su celular es su control.
5. Comparte el enlace con amigos. Cada amigo abre el enlace en su computador → ve su QR → lo escanea → escribe su nombre → listo.
6. La pantalla del computador pasa automáticamente del QR a la vista de jugador al vincular el celular.

---

## Editar configuraciones (Etapa 2+)

| Archivo | Qué editar |
|---------|-----------|
| `config/cars.js` | Estadísticas de los 10 carros |
| `config/weapons.js` | Parámetros de las 7+ armas |
| `config/tracks.js` | Datos de las 10 pistas |
| `config/scoring.js` | Puntos por posición, kills, cajas |

---

## Etapas de desarrollo

| # | Estado | Descripción |
|---|--------|-------------|
| 1 | ✅ **Completa** | Servidor, salas, QR, vinculación, reconexión |
| 2 | ✅ **Completa** | Selección de carro/arma, estado LISTO, panel admin completo |
| 3 | ✅ **Completa** | Simulación en servidor: física a 60 Hz, derrape, control gyro, cámara |
| 4 | ✅ **Completa** | Pistas procedimentales, vueltas, checkpoints, minimapa |
| 5 | ✅ **Completa** | Armas (balas, minas), daño, muerte, respawn |
| 6 | ✅ **Completa** | Objetos en pista (boost pads, cajas de reparación, munición, escudos y nitro) |
| 7 | ✅ **Completa** | Puntuación por carrera, campeonato, clasificación y podio final |
| 8 | 🔲 Pendiente | Pistas restantes, balance, despliegue |

## Puntuación y campeonato

Al terminar una carrera, el servidor calcula de forma autoritativa los puntos
por posición, eliminaciones, cajas especiales y muertes usando
`config/scoring.js`. La pantalla de cada jugador muestra los resultados de la
carrera y la clasificación acumulada.

En modo **Campeonato**, las pistas se recorren en el orden de
`settings.trackOrder` (por defecto, las 10 pistas de `config/tracks.js`).
Después de una carrera, el anfitrión puede volver a pulsar **Iniciar** para
continuar con la siguiente pista; al completar la última carrera se muestra el
podio final. En modo **Carrera única**, los resultados también se muestran,
pero no se avanza a otra pista automáticamente.

Las estadísticas de kills, muertes y puntos se calculan en el servidor y no
pueden ser alteradas desde el navegador.
