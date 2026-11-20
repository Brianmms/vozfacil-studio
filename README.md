# VozFácil Studio

Aplicación web local diseñada para ayudar a personas hispanohablantes que no saben inglés a **practicar frase por frase**, **evaluar su pronunciación con IA (DeepSeek Flash 4.1)** y **grabar/unir múltiples audios como en un estudio**.

## ¿Qué hace esta app?

1. **1. Practicar por Partes**
   - Viene pre-cargada con el guion completo del **cumpleaños #11 de Sofía**, dividido en **17 partes cortas** con sus indicaciones de pausa y tono (`(Pausa breve)`, `(Sonríe al hablar)`, `(Voz elegante y pausada)`).
   - Muestra cómo suena cada frase aproximadamente en español, su traducción y trucos fáciles.
   - Permite escuchar cada frase a velocidad normal o muy lenta (`0.6x`, `0.75x`, `0.9x`, `1.0x`), repetir en bucle, modo **Palabra por palabra**, o hacer clic en cualquier palabra suelta para oírla y ver su guía.
   - Permite grabar múltiples tomas por cada parte, subir audios desde el celular, evaluar cada toma con IA y marcar la toma elegida (`⭐`) para el estudio.
   - También puedes pegar cualquier otro texto nuevo para dividirlo automáticamente con DeepSeek Flash.

2. **2. Estudio y Unir Audios**
   - Carga automáticamente todas las tomas elegidas del guion en orden, y permite además grabar nuevos clips libres o subir varios archivos (`.mp3`, `.wav`, `.m4a`, `.ogg`, etc.).
   - Incluye forma de onda visual, recorte manual de inicio/fin, botón **Auto-recortar silencios**, control de pausas entre cada parte, volumen individual, normalización automática de volumen y transiciones suaves anti-clics.
   - Une todo en el navegador (sin necesidad de instalar `ffmpeg` ni Python) y lo exporta listo para descargar en **MP3** o **WAV**.

3. **3. Evaluar Texto + Audio**
   - Pega cualquier texto en inglés, sube cualquier grabación o graba directo en pantalla, y obtén un puntaje `0–100%` con análisis palabra por palabra (qué salió bien, qué faltó o sonó diferente) y consejos en español para mejorar.

---

## Requisitos e Instalación

Solo necesitas **Node.js** (probado con v20.11.1). Todo el procesamiento de audio funciona nativamente en el navegador con **Web Audio API**.

1. Instala las dependencias:
   ```bash
   npm install
   ```

2. Configura tu clave de DeepSeek en el archivo `.env` (puedes usar `.env.example` como referencia):
   ```env
   DEEPSEEK_API_KEY=sk-tu-api-key-de-deepseek
   DEEPSEEK_BASE_URL=https://api.deepseek.com
   DEEPSEEK_MODEL=deepseek-flash
   PORT=3001
   ```
   > **Tip**: Si agregas o cambias la clave mientras la app está abierta, solo haz clic en **"Re-verificar .env"** en la barra superior.

3. Inicia la aplicación en modo local y red Wi-Fi (con HTTPS para habilitar micrófono en celulares/tablets):
   ```bash
   npm run dev
   ```
   - En esta computadora abre: **https://localhost:5173**
   - Desde otro dispositivo en el mismo Wi-Fi abre la URL `Network:` que aparece en la terminal (por ejemplo **https://192.168.31.143:5173**).

### Acceso desde el celular u otra computadora

1. Al abrir `https://<IP-Wi-Fi>:5173` por primera vez, el navegador mostrará un aviso de seguridad porque usa un certificado local autofirmado. Pulsa **Avanzado → Continuar** (o *"Visitar este sitio web"* en iOS/Safari) para habilitar la página y el micrófono.
2. Si desde otro dispositivo no carga la página, revisa el **Firewall de Windows** para permitir tráfico entrante a **Node.js** (o al puerto **5173**) en tu red privada Wi-Fi.

## Otros comandos útiles

- `npm test`: ejecuta las pruebas unitarias de alineación de palabras y verificación del guion de Sofía.
- `npm run build`: compila el frontend para producción en `dist/`.
- `npm start`: sirve la app compilada desde el servidor Express en `http://localhost:3001`.
