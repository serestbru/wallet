# Wallet Loyalty Worker

MVP de backend para passes de Apple Wallet actualizables en Cloudflare Workers + D1.

El Worker implementa el web service de Apple Wallet, sirve el último `.pkpass` firmado cargado, guarda dispositivos y push tokens en D1 y ofrece un playground administrativo para marcar un pass como actualizado y enviar un push APNs.

La firma del `.pkpass` se realiza fuera del Worker con OpenSSL. La clave privada de Pass Type ID no debe entrar en Cloudflare ni en el repositorio.

## 1. Preparar el proyecto

Requisitos: Node.js 20+, npm, una cuenta Cloudflare y certificados de Apple Wallet.

```bash
cd wallet
npm install
cp .dev.vars.example .dev.vars
```

Edita `.dev.vars` y sustituye `ADMIN_API_KEY` por un valor aleatorio largo. `.dev.vars` está ignorado por Git.

## 2. Crear D1 y desplegar

```bash
npx wrangler login
npx wrangler d1 create wallet-db
```

Copia el `database_id` de la salida en `wrangler.toml`, sustituyendo `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Aplica las migraciones:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Configura secretos de producción. No pongas estos valores en `[vars]` ni en el repositorio:

```bash
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put APPLE_PASS_AUTH_TOKEN
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_PRIVATE_KEY
```

`APPLE_PASS_AUTH_TOKEN` solo sirve como bootstrap. El flujo recomendado es crear cada pass con la API administrativa y usar un token distinto por pass.

Publica:

```bash
npm run deploy
```

## 3. Crear y firmar un `.pkpass`

Necesitas en Apple Developer un Pass Type ID, su certificado, la clave privada correspondiente y el certificado WWDR de Apple. Prepara una carpeta, por ejemplo `pass/`, con `pass.json`, `icon.png`, `icon@2x.png` y cualquier otra imagen referenciada.

El `pass.json` mínimo debe contener `formatVersion`, `passTypeIdentifier`, `serialNumber`, `teamIdentifier`, `organizationName`, `description` y un tipo de pass como `generic`.

Genera el archivo firmado:

```bash
npm run make:pkpass -- \
  --input ./pass \
  --output ./pass.pkpass \
  --certificate ./certs/pass-cert.pem \
  --key ./certs/pass-key.pem \
  --wwdr ./certs/AppleWWDRCA.pem
```

El script crea `manifest.json`, la firma CMS `signature` y comprime el paquete. No copies las claves a `pass/` ni las subas al repositorio.

En `pass.json`, usa como mínimo:

```json
{
  "webServiceURL": "https://TU_WORKER.workers.dev/apple-wallet",
  "authenticationToken": "un-token-largo-y-unico-para-este-pass"
}
```

## 4. Cargar el pass en el Worker

```bash
export API="https://TU_WORKER.workers.dev"
export ADMIN_API_KEY="..."
export PASS_TYPE_ID="pass.com.example.loyalty"
export SERIAL="demo-001"
export PASS_TOKEN="un-token-largo-y-unico-para-este-pass"
```

Crea el registro del pass:

```bash
curl -X PUT "$API/admin/passes/$PASS_TYPE_ID/$SERIAL" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"authenticationToken\":\"$PASS_TOKEN\"}"
```

Sube el `.pkpass` firmado:

```bash
curl -X PUT "$API/admin/passes/$PASS_TYPE_ID/$SERIAL/pkpass" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/vnd.apple.pkpass' \
  --data-binary @pass.pkpass
```

Para añadirlo a Wallet, abre en un iPhone la URL HTTPS de un `.pkpass` firmado. El endpoint de actualización del Worker no sustituye al primer fichero que se instala.

Para este MVP puedes usar la URL de instalación protegida por el token del pass:

```text
https://TU_WORKER.workers.dev/install/pass.com.example.loyalty/demo-001?token=un-token-largo-y-unico-para-este-pass
```

Ábrela en Safari en el iPhone y confirma “Añadir”. Para producción conviene sustituir esta URL con token por un enlace de instalación de un solo uso.

## 5. Playground de actualización y notificaciones

Para simular que cambió el contenido:

```bash
curl -X POST "$API/admin/passes/$PASS_TYPE_ID/$SERIAL" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Para enviar la notificación silenciosa a los dispositivos registrados:

```bash
curl -X POST "$API/admin/passes/$PASS_TYPE_ID/$SERIAL/notify" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Sin `APNS_*`, la respuesta indica cuántos dispositivos están registrados pero no llama a Apple. Con `APNS_*`, el Worker firma un JWT ES256 y llama al endpoint APNs sandbox o producción según `APNS_ENVIRONMENT`.

El push no contiene el pass. Solo despierta Wallet; después Wallet consulta los seriales modificados y descarga el `.pkpass` nuevo desde el Worker.

## 6. Desarrollo local

```bash
npm run db:migrate:local
npm run dev
curl http://localhost:8787/health
```

Para probar el registro manualmente:

```bash
curl -X POST "http://localhost:8787/apple-wallet/v1/devices/device-demo/registrations/$PASS_TYPE_ID/$SERIAL" \
  -H "Authorization: ApplePass $PASS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"pushToken":"001122aabbcc"}'
```

## Seguridad y límites del MVP

- Usa un `authenticationToken` distinto para cada pass.
- Usa `ADMIN_API_KEY` solo desde un entorno controlado; todavía no hay usuarios ni roles.
- No subas `.p12`, `.pem`, `.p8`, `.dev.vars` ni claves APNs.
- D1 almacena el `.pkpass` binario para simplificar el MVP. Si los passes crecen mucho, migra ese campo a R2.
- El envío APNs está pensado para playground y bajo volumen; para producción conviene añadir reintentos, limpieza de tokens inválidos y control de concurrencia.
