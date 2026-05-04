# 🤖 Bot de Discord con IA usando Groq (Gratis)
 
## Lo que necesitas
 
- **Node.js** instalado en tu PC
- Una cuenta en [discord.com/developers](https://discord.com/developers/applications)
- Una API Key de Groq → [console.groq.com](https://console.groq.com)
---
 
## Paso 1 — Configurar el proyecto
 
```bash
mkdir mi-bot-discord
cd mi-bot-discord
npm init -y
npm install discord.js dotenv groq-sdk
```
 
---
 
## Paso 2 — Crear archivo `.env`
 
```env
DISCORD_TOKEN=tu_token_de_discord
GROQ_API_KEY=tu_api_key_de_groq
```
 
---
 
## Paso 3 — Crear archivo `index.js` con el código del bot
 
```javascript
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const Groq = require('groq-sdk');
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});
 
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
 
const conversaciones = new Map();
 
client.once('clientReady', () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});
 
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;
 
  const userId = message.author.id;
  const texto = message.content.replace(`<@${client.user.id}>`, '').trim();
 
  if (!texto) {
    message.reply('¡Hola! ¿En qué te puedo ayudar? 😊');
    return;
  }
 
  if (!conversaciones.has(userId)) {
    conversaciones.set(userId, []);
  }
  const historial = conversaciones.get(userId);
 
  historial.push({ role: 'user', content: texto });
  if (historial.length > 20) historial.splice(0, historial.length - 20);
 
  try {
    await message.channel.sendTyping();
 
    const respuesta = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente amigable en un servidor de Discord. Responde de forma natural y conversacional en el mismo idioma del usuario. Usa emojis ocasionalmente.'
        },
        ...historial
      ],
      max_tokens: 1024,
    });
 
    const textoRespuesta = respuesta.choices[0].message.content;
    historial.push({ role: 'assistant', content: textoRespuesta });
 
    if (textoRespuesta.length > 2000) {
      const partes = textoRespuesta.match(/.{1,2000}/gs);
      for (const parte of partes) {
        await message.reply(parte);
      }
    } else {
      await message.reply(textoRespuesta);
    }
 
  } catch (error) {
    console.error(error);
    message.reply('❌ Hubo un error al procesar tu mensaje.');
  }
});
 
client.login(process.env.DISCORD_TOKEN);
```
 
---
 
## Paso 4 — Ejecutar el bot
 
```bash
node index.js
```
 
Si todo está bien verás:
```
✅ Bot conectado como NombreDetuBot#1234
```
 
---
 
## ⚙️ Puntos clave a tener en cuenta
 
- **El bot responde cuando lo mencionas** con `@NombreDelBot`. Puedes cambiar esto para que responda en un canal específico.
- **Memoria por usuario:** cada usuario tiene su propio historial de conversación, así el bot recuerda el contexto.
- **Puedes personalizar el `system`** para darle una personalidad específica al bot (serio, gracioso, experto en un tema, etc.).
- En el portal de Discord, activa el permiso **"Message Content Intent"** en la sección **Bot**, si no el bot no podrá leer mensajes.
---
 
## ☁️ Hosting gratuito 24/7
 
Para mantener el bot activo sin tener tu PC encendida puedes usar [Railway](https://railway.app). Simplemente conecta tu repositorio de GitHub y agrega las variables de entorno `DISCORD_TOKEN` y `GROQ_API_KEY` en la sección **Variables**.
