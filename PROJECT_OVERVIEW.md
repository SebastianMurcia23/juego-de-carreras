# Road Rumble: estado actual del proyecto

## 1. Resumen

Road Rumble es un juego web multijugador de carreras con armas. La idea
principal es usar el computador o una pantalla grande para mostrar la carrera
y usar el celular como volante y control de cada jugador.

La aplicación está construida con Node.js, Express, Socket.IO, HTML, CSS y
JavaScript del lado del cliente. El servidor mantiene la autoridad sobre las
salas, la física, las colisiones, el daño, las vueltas, los resultados y la
puntuación.

Actualmente el proyecto incluye:

- Creación de salas con códigos de cuatro letras.
- Hasta 12 jugadores por sala.
- Un computador o pantalla por jugador.
- Un celular vinculado como control mediante un código QR.
- Reconexión de anfitrión, pantalla y celular.
- Selección de carro y arma (modo clásico) o karts F1 con poderes arcade (modo `ARCADE_ITEMS`).
- Modo Arcade de Fórmula 1 estilo Mario Kart (activo por defecto con `ARCADE_ITEMS: true`): 6 poderes (`turbo`, `disco`, `misil`, `aceite`, `invencibilidad`, `tinta`), cajas de ítems arcoíris ("?"), ruleta autoritativa, probabilidades dinámicas según posición, sin armas letales ni barras de salud.
- Lobby con estados de selección y listo.
- Configuración de carrera única o campeonato.
- Física de conducción y derrape calculada en el servidor.
- Pistas procedurales con checkpoints, vueltas, terrenos y minimapa.
- Armas, proyectiles, minas, daño, escudos, eliminaciones y respawn (modo clásico) o sistema de colisiones con rebotes no letales y aturdimientos por poderes (modo arcade).
- Boost pads y objetos recolectables.
- Resultados de carrera, puntuación y clasificación del campeonato.
- PWA básica, catálogo de cosméticos, misiones y clasificación por XP.

## 2. Cómo se ejecuta

Requisitos:

- Node.js 18 o superior.
- npm.
- Un navegador moderno en el computador y en el celular.

Instalación y ejecución:

```bash
npm install
npm start
```

La aplicación HTTP queda disponible normalmente en:

```text
http://localhost:3000
```

También existe un servidor HTTPS local opcional. Si están presentes
`cert.pem` y `key.pem` en la raíz, el servidor intenta abrir:

```text
https://<IP_LOCAL>:3443
```

El HTTPS es importante para que los navegadores permitan el acceso al
giroscopio del celular. Para jugar desde celulares en otra red o publicar una
partida se puede usar un túnel HTTPS, por ejemplo Cloudflare Tunnel o ngrok.
En ese caso hay que definir `BASE_URL` para que los códigos QR apunten a la
dirección pública correcta.

Variables de entorno:

| Variable | Uso | Valor por defecto |
|---|---|---|
| `PORT` | Puerto HTTP principal | `3000` |
| `HTTPS_PORT` | Puerto HTTPS local cuando existen certificado y llave | `3443` |
| `BASE_URL` | URL base usada para enlaces y QR | Detectada automáticamente |
| `PAYMENT_PROVIDER` | Indica un proveedor de pagos configurado | Sin configurar |

Comandos disponibles en `package.json`:

- `npm start`: inicia `server/index.js`.
- `npm run dev`: inicia el servidor mediante `nodemon`.

## 3. Estructura de carpetas

```text
/
├── README.md
├── package.json
├── package-lock.json
├── cert.pem
├── key.pem
├── client/
│   ├── index.html
│   ├── join.html
│   ├── controller.html
│   ├── manifest.webmanifest
│   ├── service-worker.js
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── fx/
│       │   ├── particles.js
│       │   └── itemMeshes.js
│       ├── main.js
│       ├── player.js
│       ├── controller.js
│       ├── gameRenderer.js
│       ├── threeGameRenderer.js
│       ├── renderCar.js
│       └── productHub.js
├── config/
│   ├── cars.js
│   ├── cars.legacy.js
│   ├── cars.f1.js
│   ├── weapons.js
│   ├── tracks.js
│   ├── tracks.legacy.js
│   ├── tracks.f1.js
│   ├── tracks-geo.json
│   ├── feature-flags.js
│   ├── scoring.js
│   └── product.js
├── server/
│   ├── index.js
│   ├── RoomManager.js
│   ├── GameRoom.js
│   ├── ItemSystem.js
│   ├── TrackGenerator.js
│   └── ProductManager.js
└── shared/
    └── constants.js
```

Herramientas de generación y revisión:

```text
tools/
├── build-tracks.js
├── verify-tracks.js
├── track-verification.json
├── verify-bots.js
├── bot-verification.json
├── verify-items.js
├── items-verification.json
└── track-contact-sheet.html
```

## 4. Pantallas y flujo de usuario

### 4.1 Pantalla principal

`/` muestra la pantalla del anfitrión. Desde allí se crea una sala, se
visualiza el código de la sala, se administran los jugadores y se configuran
la modalidad, la pista, las vueltas, la munición y el fuego amigo.

El anfitrión recibe un QR para vincular su propio celular y también un enlace
de invitación para que otros jugadores abran la sala en sus computadores.

### 4.2 Pantalla de invitado

`/join/:code` permite que otro computador se una a una sala existente. Ese
computador recibe su propio asiento, su QR y su enlace de control. Cuando el
celular escanea el QR, la pantalla del jugador deja de esperar y pasa a la
selección de carro y arma.

### 4.3 Control del celular

`/control/:token` es la interfaz móvil. Incluye:

- Entrada del nombre del piloto.
- Selección de carro y arma.
- Botón para marcarse como listo.
- Control de aceleración, freno, disparo y derrape.
- Dirección mediante giroscopio o inclinación del dispositivo.
- Calibración del centro del giroscopio.
- Botón de restauración o respawn cuando el vehículo queda atascado.
- Reintento de conexión y recuperación del token guardado.

El nombre y el token del control se guardan en `localStorage` para facilitar
la reconexión.

### 4.4 Pantalla de carrera

La pantalla de carrera recibe los estados del servidor y muestra:

- Vehículos y posiciones.
- Pista y límites.
- Cámara de seguimiento.
- Velocidad, salud, munición y progreso.
- Vueltas y checkpoints.
- Proyectiles, minas, explosiones, pickups y efectos.
- Cuenta regresiva y resultados.

Existe un renderizador Canvas en `gameRenderer.js` y un renderizador 3D basado
en Three.js en `threeGameRenderer.js`. Si Three.js no está disponible, el
cliente conserva el renderizador Canvas como alternativa.

## 5. Flujo completo de una partida

1. El anfitrión crea una sala.
2. `RoomManager` genera un código de cuatro letras, un token de anfitrión y
   un token de asiento.
3. El servidor genera un QR con la URL del control móvil.
4. Cada invitado abre `/join/:code` y recibe su propio asiento y QR.
5. Cada celular se vincula mediante `LINK_SEAT` y proporciona el nombre del
   piloto.
6. Los jugadores seleccionan carro y arma.
7. Cada jugador marca su asiento como listo.
8. El anfitrión ajusta la configuración y pulsa iniciar.
9. `GameRoom` genera la pista y comienza una cuenta regresiva de tres
   segundos.
10. Durante la carrera, los celulares envían controles y el servidor ejecuta
    la simulación.
11. El servidor transmite el estado completo de la carrera aproximadamente
    30 veces por segundo.
12. Al terminar todos los jugadores o cumplirse la condición de finalización,
    el servidor calcula posiciones, puntos y clasificación.
13. En modo campeonato, el anfitrión puede iniciar la siguiente carrera. Al
    completar la última pista se muestra el podio final.

## 6. Servidor y comunicación en tiempo real

### `server/index.js`

Es el punto de entrada. Configura Express, Socket.IO, archivos estáticos,
rutas HTML, API REST y eventos de Socket.IO. También intenta iniciar el
servidor HTTPS local cuando encuentra `cert.pem` y `key.pem`.

Archivos estáticos publicados:

- `/`: contenido de `client/`.
- `/vendor/three`: Three.js instalado en `node_modules`.
- `/shared`: constantes compartidas.
- `/config`: catálogos de carros, armas, pistas y puntuación.

### `server/RoomManager.js`

Administra el estado de las salas en memoria:

- Salas y códigos.
- Tokens de anfitrión y asiento.
- Relación entre sockets, computadores y celulares.
- Generación de QR.
- Jugadores y orden de entrada.
- Loadouts.
- Estados de listo.
- Configuración de sala.
- Expulsión de jugadores.
- Reconexiones.
- Transferencia del anfitrión.
- Creación de `GameRoom`.

Si el anfitrión se desconecta, existe una ventana de 60 segundos para
reconectarse. Si no vuelve, el servidor puede transferir el rol al jugador
conectado más antiguo. Si no hay candidatos, la sala se cierra.

### `server/GameRoom.js`

Es la simulación autoritativa de una carrera. Ejecuta un paso fijo de física
cada `1 / 30` segundos y procesa:

- Aceleración, freno y reversa.
- Dirección progresiva tipo modelo de bicicleta.
- Agarre lateral y derrape.
- Fricción y resistencia aerodinámica.
- Límite de velocidad por carro.
- Terreno y tracción.
- Límites de la carretera.
- Colisiones entre carros.
- Boost pads.
- Pickups.
- Disparo y consumo de munición.
- Proyectiles y minas.
- Daño, blindaje y escudos.
- Eliminación, muertes, kills y respawn.
- Checkpoints, vueltas y posiciones.
- Resultados y clasificación acumulada.

El cliente no decide el resultado de la carrera: solo envía entradas y dibuja
el estado recibido.

### `server/ItemSystem.js` (Modo Arcade)

Gestiona de forma 100% autoritativa el sistema de poderes cuando `ARCADE_ITEMS: true`:

- **Cajas de ítems:** Distribuidas en filas de 3 en múltiples checkpoints de la pista con respawn de 3.0s tras recogida.
- **Ruleta autoritativa:** Tiempo de giro obligatorio de 0.9s (`ROULETTE_DURATION`). Rechaza cualquier intento de uso anticipado.
- **Probabilidades según posición:** Matriz de pesos interpolada linealmente entre el 1º y el último lugar:
  - Primeros puestos reciben principalmente `aceite` y `disco`.
  - Últimos puestos reciben poderes de recuperación: `misil`, `estrella` (invencibilidad) y `turbo`.
  - Rango medio recibe balance de `tinta`, `disco` y `turbo`.
- **6 Poderes Arcade:**
  1. `turbo`: Impulso instantáneo (+380 px/s, fricción reducida por 1.8s).
  2. `disco`: Proyectil rebotador de alta velocidad (720 px/s, vida 7s, hasta 6 rebotes en bordes).
  3. `misil`: Proyectil guiado térmico que persigue al rival inmediatamente por delante (velocidad 620 px/s, giro `PI * dt`, vida 8s).
  4. `aceite`: Mancha estática en pista (vida 14s, aturde 1.8s a quien la pisa).
  5. `invencibilidad`: Estado invulnerable por 4.5s (+40% velocidad, atraviesa aceite y bloquea proyectiles, aturde a karts rivales al contacto).
  6. `tinta`: Mancha de visión instantánea a todos los rivales situados por delante durante 3.0s.
- **IA de Bots:** Utilizan inteligentemente sus ítems con un retardo natural entre 1.0 y 4.0 segundos tras completar la ruleta.
- **Puntuación y estados:** Emite eventos autoritativos de socket (`ITEM_BOX_TAKEN`, `ITEM_ROLLING`, `ITEM_USED`, `ITEM_HIT`, `ITEM_BLOCKED`) y suma 1 punto de habilidad por impacto con poder.

### `server/TrackGenerator.js`

Convierte la configuración de una pista en geometría jugable. Genera:

- Circuito cerrado.
- Checkpoints interpolados con Catmull-Rom.
- Ángulos de cada segmento.
- Límites para el minimapa.
- Posiciones de salida para hasta 12 jugadores.
- Boost pads.
- Pickups de reparación, munición, escudo y nitro.
- Tipos de terreno deterministas según el identificador de la pista.

La forma es procedural, pero es reproducible para cada pista porque usa un
generador pseudoaleatorio basado en el identificador.

### `server/ProductManager.js`

Administra perfiles y progresión en memoria:

- Perfil por identificador de dispositivo.
- Nombre, XP, nivel, monedas y gemas.
- Inventario de cosméticos.
- Estadísticas de carreras, victorias, podios y kills.
- Compras con monedas.
- Tabla de clasificación por XP.

## 7. Configuración de contenido

### Carros: `config/cars.js`

Hay 10 carros con roles y estadísticas diferentes:

1. Apex Venom: superdeportivo rápido y frágil.
2. Goliath Mk4: tanque pesado.
3. Drift Phantom: especialista en derrape.
4. Mud Crusher: vehículo off-road.
5. Viper GT: balanceado.
6. Nitro Wasp: ligero y muy ágil.
7. Iron Boar: muscle car agresivo.
8. Cyber Storm: prototipo aerodinámico.
9. Dune Raider: buggy todo terreno.
10. Titan Roller: camión de asalto pesado.

Las estadísticas principales son velocidad máxima, aceleración, manejo,
derrape, blindaje, peso y tracción por terreno. Cada carro también tiene
colores, dimensiones y una forma visual.

### Armas: `config/weapons.js`

Hay 7 armas:

- Ametralladora Vulcan.
- Escopeta Thunder.
- Bazuca Goliath.
- Cohetes guiados Stalker.
- Lanzallamas Inferno.
- Cañón láser/Railgun.
- Minas de proximidad.

Cada arma define tipo, daño, cadencia, munición, alcance, velocidad del
proyectil, dispersión y parámetros visuales. La simulación actual implementa
directamente proyectiles, ráfagas, explosivos y minas; algunos campos del
catálogo describen el balance previsto y pueden requerir una implementación
más especializada para comportamientos avanzados como guiado, haz continuo o
daño de área completo.

### Pistas: `config/tracks.js`

Hay 10 configuraciones de pista:

1. Circuito Neon City.
2. Cañón Polvoriento.
3. Puerto Cyberpunk.
4. Desierto Calcinado.
5. Ruinas Industriales.
6. Autopista Elevada.
7. Selva Tóxica.
8. Mina Subterránea.
9. Volcán de Obsidiana.
10. Gran Premio Omega.

Cada una define descripción, terreno, nivel de agarre, dificultad, color,
vueltas por defecto, longitud y cantidad de checkpoints. La geometría final
se genera en el servidor.

### Puntuación: `config/scoring.js`

La puntuación actual es:

- 25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0 puntos para las posiciones 1 a
  12.
- 3 puntos por kill.
- 2 puntos por caja especial.
- 2 puntos por vuelta más rápida.
- -1 punto por muerte.

La puntuación de campeonato se acumula por jugador y se conserva dentro de la
sala mientras el proceso del servidor siga activo.

### Producto: `config/product.js`

Incluye:

- Cosméticos de tipo skin, trail y badge.
- Misiones diarias y semanales.
- Temporada `season-01-launch`.
- Recompensas gratuitas y premium.
- Fecha de finalización configurada para el 31 de enero de 2027.

## 8. API REST actual

### Salas y configuración

```text
GET /api/room/:code
GET /api/config
GET /api/health
```

`/api/health` devuelve `ok` y el tiempo de actividad del proceso.

La validación de integración confirmó que `/api/health` y `/api/config`
responden `200`; la configuración activa expone 10 carros, 40 pistas y 40
identificadores de pista únicos.

La validación en navegador confirmó:

- el lobby carga los 10 carros y las 40 pistas F1;
- la creación de sala genera código, enlace de invitación y QR;
- el flujo permite seleccionar monoplaza y arma y marcar al piloto como listo;
- el controlador móvil carga dirección, aceleración, freno, drift y arma.

Solo se observaron advertencias esperadas de `requestFullscreen` cuando el
navegador no ejecuta la acción desde un gesto del usuario.

También se reorganizó el modelo 3D del monoplaza en
`client/js/threeGameRenderer.js`: la carrocería, nariz, cockpit, ruedas y
alerones ahora comparten un eje local coherente; el alerón trasero queda
horizontal y se eliminó el soporte vertical desproporcionado que hacía que el
vehículo se viera desarmado desde la cámara de carrera.

El ritmo de carrera se incrementó sin igualar artificialmente los vehículos:
`CAR_SPEED_MULTIPLIER` pasó de `1.2` a `1.6` y la aceleración global de `420` a
`540 px/s²`. El frenado subió a `700 px/s²` para conservar el control a alta
velocidad. Las estadísticas individuales (`maxSpeed`, `acceleration`,
handling, drift, armor, weight y tracción) siguen determinando las diferencias
entre carros; por ejemplo, Apex Venom mantiene una velocidad máxima superior a
Goliath Mk4 y Titan Roller.

La pantalla de carrera ahora incluye:

- línea/zona visual de salida y meta sobre la pista 2D y 3D;
- minimapa fijo con el trazado, la salida/meta y la posición de cada carro;
- posición actual del piloto en el HUD;
- clasificación que cambia a `LLEGÓ Pn` cuando cada carro cruza la meta;
- evento Socket.IO `car_finished` con piloto, puesto y tiempo de llegada;
- aviso inmediato de cada llegada, sin esperar a que terminen todos los
  participantes.

El HUD 3D también muestra ahora la vuelta actual en formato `VUELTA n/N`.
La simulación fue verificada forzando tres recorridos completos: el servidor
registró tres eventos `lap_completed` y una llegada final `car_finished`.

Después de aumentar la velocidad se reforzó la detección de checkpoints:
ahora el servidor comprueba la distancia al tramo recorrido entre el tick
anterior y el actual, no solo la posición final del tick. Esto evita que un
monoplaza rápido atraviese un checkpoint sin registrarlo y quede bloqueado en
una vuelta. La verificación confirmó tres vueltas y llegada final, además de
40/40 pistas completables con el bot.

Se retiraron del render 3D las barreras, gradas y árboles decorativos que
podían aparecer dentro del asfalto. El servidor ahora limita el centro del
carro al ancho útil de la carretera, corrige la velocidad hacia fuera y aplica
daño al golpear el margen.

Los choques entre carros conservan la separación y el rebote según el peso,
pero ahora cualquier impacto significativo reduce la vida de ambos vehículos
según la velocidad relativa y la armadura; si la vida llega a cero se ejecuta
la eliminación normal del juego.

Los pickups de carrera ahora aparecen como cajas de objeto aleatorias. Al
recoger una caja puede salir reparación, munición, escudo, turbo, Estrella
(invulnerabilidad temporal), Pulso EMP (ralentiza a los rivales), Bomba de
Impacto (daño de área), Trampa de Derrape, Rayo, Cohete Perseguidor o Frenesí
Turbo. Las cajas se muestran tanto en Canvas como en la vista 3D y el jugador
recibe una notificación con el poder obtenido.

Los cuatro poderes arcade nuevos tienen comportamiento autoritativo:

- **Trampa de Derrape** deja una trampa amarilla detrás del vehículo; al
  activarse daña, empuja y ralentiza al rival.
- **Rayo** alcanza a los rivales cercanos, les causa daño y los aturde
  temporalmente.
- **Cohete Perseguidor** crea un proyectil teledirigido que busca al rival más
  cercano.
- **Frenesí Turbo** combina turbo temporal con una cadencia de disparo más
  rápida.

La activación de poderes emite `powerup_effect`, que produce anillos, rayos,
brillos y auras animadas en los renderizadores Canvas y Three.js. Los estados
de Estrella, EMP y Frenesí también se reflejan alrededor de cada vehículo.

Las cajas ahora entregan el poder al inventario del vehículo; no lo activan
automáticamente. Cada piloto puede conservar una caja y activarla cuando lo
decida con el botón **PODER** del controlador móvil o la tecla **E**. El HUD
muestra el poder almacenado y bloquea la recogida de otra caja hasta consumirlo.
La ubicación de las cajas usa separación lateral variable, alterna ambos lados
de la línea de carrera y mantiene una distancia segura del borde. En 3D flotan,
giran y pulsan para que no parezcan pegadas al asfalto.

Los circuitos F1 usan ahora una calzada más ancha, de 160 px de ancho visual,
para que los monoplazas tengan más espacio en paralelo y las curvas sean más
legibles. El entorno 3D se selecciona de forma determinista por circuito:
urbano con edificios y paneles, desértico con dunas, costero con palmeras,
bosque con vegetación y un tema clásico para los restantes. También se
mantienen pianos y línea de meta de estilo circuito moderno.

La vista 3D no añade obstáculos físicos ni decorativos dentro o junto al
circuito: se conservan únicamente el asfalto, los pianos, la meta y los
elementos interactivos de carrera. El suelo se coloca por debajo del asfalto
para evitar z-fighting y parpadeos visuales.

Para reducir la sensación de retraso durante la conducción, el controlador
continúa enviando entradas a 60 Hz y el renderizador 3D aplica una predicción
visual limitada únicamente al vehículo local entre snapshots del servidor.
Los vehículos rivales siguen interpolándose de forma estable y la física,
colisiones, límites y vueltas continúan siendo autoritativos en el servidor.
La aceleración global se aumentó a 620 px/s² y el multiplicador de velocidad
de los carros a 1.8, conservando las diferencias individuales del catálogo.

Los circuitos tienen ahora cuatro carriles visuales de 46 px cada uno,
delimitados por tres líneas discontinuas; el ancho total visible es 184 px y no
se cambia el tamaño de los carros. La parrilla de salida usa cuatro columnas.
El límite físico conserva un margen autoritativo más conservador para que las
curvas importadas sigan siendo completables. La geometría de los trazados se
escala un 15% para que sean más largos sin cambiar sus curvas, checkpoints,
poderes ni reglas de carrera.

### Producto y progresión

```text
GET  /api/product/catalog
POST /api/product/profile
GET  /api/product/profile/:id
POST /api/product/purchase
GET  /api/product/leaderboard
POST /api/product/checkout
```

El endpoint de checkout devuelve `501` porque todavía no hay proveedor de
pagos configurado. No debe usarse para aceptar dinero real en el estado
actual.

## 9. Eventos Socket.IO principales

Los nombres compartidos están centralizados en `shared/constants.js`.

### Salas y asientos

- `create_room`
- `room_created`
- `join_room`
- `room_joined`
- `room_not_found`
- `room_full`
- `link_seat`
- `seat_linked`
- `seat_already_used`
- `seat_invalid`

### Reconexión

- `reconnect_host`
- `reconnect_seat`
- `reconnect_mobile`
- `host_reconnected`
- `seat_reconnected`
- `host_disconnected`
- `host_transferred`
- `player_disconnected`

### Lobby y administración

- `get_config`
- `config_data`
- `select_loadout`
- `loadout_updated`
- `toggle_ready`
- `update_settings`
- `settings_updated`
- `kick_player`
- `player_kicked`
- `start_game`
- `game_starting`

### Carrera

- `controller_input`
- `steering_input`
- `track_data`
- `game_countdown`
- `game_state`
- `lap_completed`
- `player_eliminated`
- `pickup_collected`
- `boost_pad_triggered`
- `race_finished`
- `championship_finished`
- `error`

## 10. Constantes y límites importantes

### Sala

- Máximo: 12 jugadores.
- Código: 4 letras.
- Nombre máximo: 20 caracteres.
- Tiempo para reconectar al anfitrión: 60 segundos.

### Física

- Simulación de red: 30 Hz.
- Cuenta regresiva: 3 segundos.
- Salud máxima: 100.
- Respawn: 3 segundos.
- Invulnerabilidad después del respawn: 2 segundos.
- Ancho medio de carretera: 65 unidades.
- Radio del carro: 18 unidades.
- Daño de colisión base: 5.

### Objetos

- Boost pad con duración, fuerza y cooldown.
- Pickup cada 8 segundos después de ser recogido.
- Reparación: 35 de salud.
- Munición: 50% de la munición máxima.
- Escudo: 6 segundos.

## 11. PWA y experiencia visual

La aplicación incluye un `manifest.webmanifest` con nombre, colores, modo
standalone y descripción. `service-worker.js` registra un shell básico de la
aplicación y usa la red primero con fallback a caché.

La interfaz está concentrada en `client/css/style.css`, con una estética
futurista y controles adaptados a pantallas móviles. La vista del control
intenta mantener la orientación horizontal del teléfono.

`productHub.js` añade el panel de garaje, temporada y ranking. Algunas acciones
de personalización visual muestran que el editor 3D llegará en una versión
posterior.

## 12. Estado de implementación

Según la funcionalidad presente en el código:

| Área | Estado |
|---|---|
| Servidor Express y archivos estáticos | Implementado |
| Salas, códigos, QR y vinculación móvil | Implementado |
| Reconexión y transferencia de anfitrión | Implementado |
| Selección de carro y arma | Implementado |
| Lobby, listo y administración | Implementado |
| Física autoritativa del servidor | Implementado |
| Derrape, terrenos y tracción | Implementado |
| Pistas procedurales y checkpoints | Implementado |
| Vueltas, posiciones y resultados | Implementado |
| Armas, daño, muertes y respawn | Implementado |
| Boost pads y pickups | Implementado |
| Campeonato y podio | Implementado |
| Render Canvas | Implementado |
| Render 3D con Three.js | Implementado con fallback Canvas |
| Perfil, cosméticos y compras con monedas | Implementado en memoria |
| Misiones y recompensas de temporada | Catálogo presente; progresión completa pendiente |
| Checkout de pagos reales | Pendiente; responde `501` |
| Persistencia en base de datos | Pendiente |
| Autenticación de cuentas | Pendiente |
| Webhooks e idempotencia de pagos | Pendiente |
| Balance y pruebas automatizadas | Pendiente de ampliar |
| Publicación de pistas adicionales | La configuración tiene 10; falta balance y validación de producción |

### Preparación de la Fase 1

La Fase 1 dejó una ruta reversible para sustituir pistas y apariencia de
carros:

- `config/cars.legacy.js` y `config/tracks.legacy.js` conservan los catálogos
  originales.
- `config/cars.f1.js` y `config/tracks.f1.js` son copias de staging para los
  datos que se generarán en la Fase 2.
- `config/feature-flags.js` contiene `USE_F1_TRACKS_AND_CARS`, desactivada por
  defecto.
- `config/cars.js` y `config/tracks.js` seleccionan el catálogo según la
  bandera.
- Las páginas del cliente cargan ambos catálogos antes del selector activo.

Con la bandera desactivada, el servidor y el navegador entregan exactamente
los 10 carros y las 10 pistas originales. El catálogo legacy sigue disponible
para volver atrás cambiando una sola bandera.

### Fase 2: circuitos basados en GeoJSON

Se añadió `tools/build-tracks.js`, que procesa los GeoJSON de
`bacinger/f1-circuits` y genera:

- `config/tracks-geo.json`: geometría server-only, escala, radios, checkpoints,
  estado de habilitación y atribución MIT.
- `config/tracks.f1.js`: catálogo ligero para Node.js y navegador.
- `tools/track-contact-sheet.html`: hoja SVG de revisión visual.

La ejecución procesa todos los archivos de la fuente y no elimina circuitos
históricos ni variantes. La validación identifica advertencias en los
circuitos que no alcanzan el radio mínimo o presentan cruces. Para activar la
integración se usó el override explícito `--enable-uncertified`: los 40
registros quedan activos, pero conservan `validationWarning` para que ninguna
limitación quede oculta. Sin ese override, el generador vuelve a deshabilitar
los circuitos que no superen la validación estricta.

### Integración de geometría en el servidor

`server/TrackGenerator.js` ahora tiene una rama F1 protegida por dos
condiciones:

1. `USE_F1_TRACKS_AND_CARS` debe estar activa.
2. El registro de pista debe tener `enabled: true`.

Cuando ambas condiciones se cumplen, se usa la geometría preconstruida de
`tracks-geo.json` y se generan sobre ella los ángulos, límites, posiciones de
salida, boost pads y pickups. El objeto devuelto conserva el contrato actual
de `track_data`.

Cuando la bandera está desactivada, se mantiene el generador procedural
legacy. En el estado actual la bandera está activa y las 40 pistas F1 se
generan desde `tracks-geo.json`; las advertencias geométricas no impiden la
ejecución porque la activación fue solicitada explícitamente.

### Fase visual de monoplazas

Los tres renderizadores conservan los ids, colores, dimensiones y armas, pero
ahora dibujan una silueta original de monoplaza:

- Canvas y previsualización: ruedas descubiertas, nariz baja, cabina estrecha,
  franja de acento y alerones delantero/trasero.
- Three.js: monocasco, nariz, pontones, cockpit, halo, suspensión, alerones,
  ruedas con rines y variantes visuales por carro.
- El largo visual se escala según `dimensions.length`; no se cambió el radio
  de colisión ni la física.

### Verificación de integración

`tools/verify-tracks.js` ejecuta el `TrackGenerator` real sobre las 40 pistas
activas y guarda el resultado en `tools/track-verification.json`. La
verificación actual pasó para las 40 pistas:

- Circuitos cerrados dentro de la tolerancia.
- Checkpoints en orden.
- Límites que contienen los checkpoints.
- 12 posiciones de salida por pista.
- Parrilla detrás de la línea de meta.
- Parrilla dentro de la tolerancia de carretera.
- 1,380 comprobaciones de segmentos por tick en la pista con más checkpoints,
  frente a 120 checkpoints interpolados en la pista legacy máxima.

Las 40 pistas conservan advertencias geométricas de validación porque fueron
activadas explícitamente con `--enable-uncertified`. La advertencia no se
elimina aunque el circuito sea jugable en el runtime.

También se ejecutó `tools/verify-bots.js`, un bot mínimo que apunta al
siguiente checkpoint, frena antes de errores angulares grandes y usa
`GameRoom` directamente con un adaptador Socket.IO vacío. El resultado actual
es:

- 40 de 40 pistas completaron una vuelta.
- 0 de 40 pistas fallaron dentro de 90 segundos.
- El resultado detallado está en `tools/bot-verification.json`.

La corrección se limitó a la estrategia de navegación del bot de verificación;
no se modificó `GameRoom` ni se ocultaron fallos de la simulación.

## 13. Limitaciones actuales y próximos pasos recomendados

### Persistencia

Las salas, perfiles, monedas, inventarios, XP y clasificaciones se almacenan
solo en memoria. Al reiniciar Node.js se pierde todo ese estado. Para
producción se necesita una base de datos y una estrategia de migraciones.

### Cuenta y seguridad de producto

Los perfiles se identifican con valores enviados por el cliente y guardados
en `localStorage`. Antes de habilitar economía real se necesita autenticación
de usuarios, autorización por recurso, validación más estricta, protección
contra abuso, auditoría de compras, webhooks firmados e idempotencia.

### Pagos

`PAYMENT_PROVIDER` solo aparece en el catálogo y el checkout sigue
deshabilitado. No se deben aceptar pagos reales hasta integrar un proveedor,
validar sus credenciales en el servidor y confirmar las compras mediante
webhooks.

### Producción y escalabilidad

La simulación está diseñada para un único proceso y memoria local. Para
escalar habría que definir afinidad de sesiones, almacenamiento compartido y
posiblemente un adaptador Socket.IO. También conviene restringir CORS, añadir
rate limiting, logging estructurado y gestión segura de certificados.

### Calidad y balance

El repositorio cuenta con suite de pruebas automatizadas ejecutable mediante:

```bash
npm test
```

Esta suite ejecuta secuencialmente:
1. `tools/verify-tracks.js`: Validación geométrica de las 40 pistas F1 (40/40).
2. `tools/verify-bots.js`: Simulación headless de navegación de IA y tiempos de vuelta (40/40).
3. `tools/verify-items.js`: Validación rigurosa del sistema de poderes (distribución probabilística de 2.000 tiradas, bloqueo estricto de ruleta de 0.9s, restricción de 1 ítem a la vez, ciclo de vida de proyectiles y simulación continua headless de 3 minutos sin NaNs con cientos de interacciones).

### Gráficos 3D y fidelidad visual ("kart-3d-reference.html")

El renderizador 3D en `client/js/threeGameRenderer.js` replica con precisión el estilo visual de la referencia `kart-3d-reference.html`:
- **Pista y pianos:** Pista continua construida por spline `CatmullRomCurve3` y cintas con franjas alternadas de asfalto (`#3b3d42` / `#44464c`), pianos rojo y blanco en ambos costados (`#e24b4a` / `#ffffff`) y línea central discontinua.
- **Arco de meta:** Arco 3D sobre la línea de llegada con postes oscuros, barra superior a cuadros y línea en piso con textura de tablero de ajedrez.
- **Iluminación y sombras dinámicas:** `DirectionalLight` que persigue la posición del kart local proyectando sombras suaves (`PCFSoftShadowMap`) en un radio centrado, complementado por `HemisphereLight` para iluminación ambiental natural.
- **Entorno natural:** Césped verde estilo Mario Kart (`#5fa84a`), más de 100 árboles procedurales (tronco cilíndrico y follaje cónico bi-color), 14 montañas poligonales en el horizonte y 10 grupos de nubes a la deriva animadas en tiempo real.
- **Atmósfera:** Cielo celeste vibrante (`#9fd3f5`) con niebla gradual a juego.

## 14. Archivos clave para continuar el desarrollo

| Necesidad | Archivo principal |
|---|---|
| Rutas HTTP y Socket.IO | `server/index.js` |
| Salas, QR y reconexión | `server/RoomManager.js` |
| Física y reglas de carrera | `server/GameRoom.js` |
| Sistema arcade de poderes y cajas | `server/ItemSystem.js` |
| Generación de circuitos | `server/TrackGenerator.js` |
| Progresión y tienda | `server/ProductManager.js` |
| Eventos y constantes comunes | `shared/constants.js` |
| Flags de funcionalidad (`ARCADE_ITEMS`) | `config/feature-flags.js` |
| Carros | `config/cars.js` |
| Armas (modo clásico) | `config/weapons.js` |
| Pistas | `config/tracks.js` |
| Puntuación | `config/scoring.js` |
| Cosméticos y temporada | `config/product.js` |
| Lógica del anfitrión | `client/js/main.js` |
| Lógica del jugador | `client/js/player.js` |
| Control móvil y vibración háptica | `client/js/controller.js` |
| Render Canvas (2D) | `client/js/gameRenderer.js` |
| Render Three.js (3D, karts, cámara y HUD) | `client/js/threeGameRenderer.js` |
| Partículas visuales (pool sin asignación) | `client/js/fx/particles.js` |
| Modelos 3D de ítems (caja, disco, misil, aceite) | `client/js/fx/itemMeshes.js` |
| Previsualización de carros | `client/js/renderCar.js` |
| Garaje y producto | `client/js/productHub.js` |

## 15. Historial de cambios recientes

### Tarea 7: Menús amigables y modo arcade sin armas (IU limpia)

**Objetivo:** eliminar toda referencia visible a armas cuando `ARCADE_ITEMS=true` y mejorar la usabilidad de los menús.

**Cambios realizados:**

| Archivo | Cambio |
|---|---|
| `client/index.html` | Subtítulo cambiado a "Carreras arcade estilo kart". Panel de vehículo muestra "PODERES ARCADE · 6 poderes por caja" en lugar del selector de armas. Botón de listo muestra "🏎️ Confirmar Vehículo". Panel admin: modo campeonato con texto más claro, distribución de poderes `positional` como primera opción (por defecto). Hint del botón Iniciar dice "Todos confirmen su vehículo antes de iniciar." |
| `client/join.html` | Mismo cambio en la sección de loadout de invitados. |
| `client/controller.html` | Tarjeta de selección de arma reemplazada por info de poderes ("Recoge cajas arcoíris…"). HUD del cockpit: columnas HP/BALAS/TURBO simplificadas a POS + VUELTA + PODER (el ítem activo). `btn-fire` oculto por defecto (`display:none`). `btn-power` con texto inicial "PASAR CAJA". Hint de calibración de giroscopio: "Si el volante está girado, toca ⧖ Calibrar con el teléfono recto." |
| `client/js/controller.js` | Nuevo elemento `hud-power-hud` actualizado en el ciclo de `GAME_STATE` con emoji + nombre del ítem. |
| `client/js/main.js` | Lista mini de jugadores: estados explícitos "Eligiendo / Confirmado ✓ / Desconectado... / Esperando QR". Lista admin: filas de jugadores desconectados con opacidad 0.6 y etiqueta "Desconectado (volviendo...)". `itemDistribution` por defecto ahora es `'positional'`. |

**Verificación:** `verify-tracks.js` (40/40), `verify-bots.js` (40/40), `verify-items.js` (5/5), `verify-championship.js` (5/5). Sin cambios en lógica de servidor.

### Tarea 8: Corrección de bug visual (cambio de pista) y flujo completo de resultados en campeonato

**Objetivos:**
- **Problema A (bug visual):** Al cambiar de pista en campeonato, los carros y cajas de poderes se volvían invisibles.
- **Problema B (flujo de resultados):** La carrera terminaba al llegar el primer carro; ahora todos finalizan (o reciben DNF por timeout). Durante el cambio de pista, la nueva pista y los carros en la parrilla se cargan en segundo plano mientras se muestra el overlay de resultados durante 10–12 s. El anfitrión puede saltarse la espera. Al terminar, un countdown `3-2-1-¡YA!` precede la nueva carrera con carros inmovilizados.

**Causa raíz confirmada (Problema A — objetos invisibles):**

1. `R.cars` y `R.itemBoxMeshes` en `threeGameRenderer.js` retenían las keys de la pista anterior. Al llegar el `TRACK_DATA` de la pista nueva, el bucle de render consideraba que los meshes ya existían y no los añadía al nuevo `R.carGroup` / `R.roadGroup`.
2. `_boxMat` en `client/js/fx/itemMeshes.js` era un singleton a nivel de módulo. `clearGroup(R.roadGroup)` llamaba `_boxMat.dispose()` al limpiar; las nuevas cajas de la siguiente pista usaban ese material ya desechado.
3. `init()` en `threeGameRenderer.js` recreaba el canvas WebGL y duplicaba el animation loop en cada `TRACK_DATA`.

**Archivos modificados:**

| Archivo | Cambio principal |
|---|---|
| `server/GameRoom.js` | `startIntermission()`: llama a `itemSystem.clear()` antes de emitir; almacena `this.countdownInterval` para poder cancelarlo; `stop()` cancela también `countdownInterval`. |
| `server/RoomManager.js` | Refactorización completa del flujo de campeonato: nueva `prepareNextChampionshipRace()` carga la pista y posiciona carros en la parrilla durante la intermisión; `startChampionshipRace()` dispara el countdown; `advanceChampionship()` detecta si ya está en intermisión y salta directo al countdown si el anfitrión lo pide. |
| `client/js/fx/itemMeshes.js` | `resetMaterials()` anula `_boxMat`; `_getBoxMat()` lo recrea limpio si fue anulado o desechado. |
| `client/js/threeGameRenderer.js` | `init()` idempotente; `resetForNewRace(track)` limpia meshes y reconstruye la escena; safeguards en `updateCars()`, `updateItemBoxes()` y `updateItemProjectiles()` para re-adjuntar meshes huérfanos; `window.__rrDebugScene()` ampliado con `carCount`, `itemBoxCount`, `projectileCount`, `cameraPosition`, `rendererActive`. |
| `client/js/gameRenderer.js` | `resetForNewRace()` y `setIntermission()` añadidos; `raceFinished/results/intermission` se resetean en cada transición. |
| `client/js/main.js` y `player.js` | Listeners para `CHAMPIONSHIP_INTERMISSION`, `CHAMPIONSHIP_FINISHED`, `CAR_FINISHED`. |
| `client/controller.html` y `controller.js` | Overlay `#ctrl-results-overlay` con posición personal, tabla de clasificación, info de siguiente pista y botón "Comenzar siguiente pista" para el anfitrión; toast/haptic en llegada; timer de intermisión con cuenta regresiva. |
| `tools/verify-championship.js` | Ampliado de 5 a 8 checks: (c) carros en parrilla con coordenadas finitas dentro de límites de la pista, inmóviles durante intermisión; (d) cajas de ítem en cada pista nueva dentro del half-width; (e) proyectiles y aceites de la carrera anterior completamente eliminados; RoomManager integration test (intermisión + host skip). |
| `package.json` | `node tools/verify-championship.js` añadido a `npm test`. |
| `client/index.html` y `controller.html` | Bump de versiones de cache buster. |

**Verificación `npm test`:** `verify-tracks` (40/40), `verify-bots` (40/40), `verify-items` (5/5), `verify-items-bounds` (40/40), `verify-championship` (8/8). ✅ Todo en verde.

**Riesgos / pendiente:**
- El countdown usa `setInterval` real de 1 s; en escenarios de alta carga el intervalo puede derivar. Para evitar arrastre de tiempo, se podría usar `Date.now()` como referencia.
- La función `drawResultsOverlay` del overlay en canvas 2D asume `ctx` global; si el renderizador cambia a 3D puro en una versión futura, deberá migrarse al HUD Three.js.

