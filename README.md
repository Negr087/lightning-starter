# ⚡ Digital Card

Tu tarjeta de presentación Bitcoin. Compartí tu identidad en la red Lightning con un link, un QR y pagos instantáneos.

🔗 **Demo**: [digitalcard-sigma.vercel.app](https://digitalcard-sigma.vercel.app)

## ¿Qué es?

Una tarjeta digital personal para el ecosistema Bitcoin/Lightning/Nostr. Ingresás tu Lightning Address, bio, links y la app genera una tarjeta compartible donde cualquiera te puede mandar sats al instante.

## ✨ Features

- **Perfil completo** — nombre, bio, avatar, banner, NIP-05
- **Recibir pagos** — invoice por QR, WebLN (extensión), NWC, NFC (Bolt Card)
- **Identidad Nostr** — importar perfil desde extensión (nos2x/Alby) o móvil (Amber/Primal via NIP-46)
- **Buscar tarjetas** — por npub, NIP-05 o Lightning Address
- **Links sociales** — GitHub, X, Nostr, Instagram, YouTube, Telegram, Discord y más
- **Persistencia cross-device** — datos guardados en Supabase, sincronizados entre PC y celular
- **Compartir** — link corto, QR y botones para WhatsApp, X y Telegram
- **Sonidos** — efectos de sonido aleatorios al confirmar un pago

## 🚀 Inicio rápido

```bash
git clone https://github.com/Negr087/digital-card.git
cd digital-card
npm install
cp .env.example .env   # completar con tus credenciales
npm run dev
```

Abrir [http://localhost:5173](http://localhost:5173)

## ⚙️ Configuración

Crear `.env` a partir de `.env.example`:

```env
# Supabase (para persistencia cross-device)
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# Opcional — para los ejemplos de Node
NWC_URL=nostr+walletconnect://...
LIGHTNING_ADDRESS=tu@email.com
```

### Tabla en Supabase

Ejecutar en el SQL Editor de tu proyecto:

```sql
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read"   ON cards FOR SELECT USING (true);
CREATE POLICY "public_insert" ON cards FOR INSERT WITH CHECK (true);
CREATE POLICY "public_update" ON cards FOR UPDATE USING (true);
```

## 🏗️ Estructura

```
digital-card/
├── public/
│   ├── sounds/          # Efectos de sonido para pagos
│   └── satoshi.webp     # Avatar del mockup
├── src/
│   ├── App.jsx          # Toda la app (Landing, CardForm, CardView, SearchView)
│   ├── storage.js       # Helpers para Supabase (save/load tarjeta)
│   ├── useNostrConnect.js  # Hook NIP-46 para conectar wallet móvil
│   └── main.jsx
├── .env.example
└── package.json
```

## 💳 Formas de pago soportadas

| Método | Desktop | Mobile |
|--------|---------|--------|
| QR (LNURL-pay) | ✅ | ✅ |
| WebLN (extensión Alby/nos2x) | ✅ | — |
| WebLN (wallet nativa) | — | ✅ Blink, Phoenix, Alby Go, etc. |
| NWC (Nostr Wallet Connect) | ✅ | ✅ |
| NFC (Bolt Card / LNURL-withdraw) | — | ✅ Chrome Android |

## 🔗 Identidad Nostr

- **Extensión** (nos2x, Alby): conecta con un click, importa nombre/bio/avatar/links
- **Móvil** (Amber, Primal): genera QR NIP-46, escaneás con la app y listo
- Los datos se sincronizan automáticamente vía Supabase usando el npub como clave

## 📦 Stack

- [React](https://react.dev) + [Vite](https://vitejs.dev)
- [@getalby/lightning-tools](https://github.com/getAlby/lightning-tools) — Lightning Address, LNURL
- [@getalby/sdk](https://github.com/getAlby/js-sdk) — NWC
- [@nostr-dev-kit/ndk](https://github.com/nostr-dev-kit/ndk) — Nostr / NIP-46
- [Supabase](https://supabase.com) — persistencia cross-device
- [qrcode.react](https://github.com/zpao/qrcode.react) — generación de QR

## 🏆 Hackathon FOUNDATIONS — Marzo 2026

Proyecto construido para la hackathon de La Crypta:

- **Fechas**: 3-31 de Marzo 2026
- **Tema**: Lightning Payments Basics
- **Premio**: 1,000,000 sats
- **Info**: [hackaton.lacrypta.ar](https://hackaton.lacrypta.ar)

---

Hecho con ⚡ por [negr0](https://github.com/Negr087)
