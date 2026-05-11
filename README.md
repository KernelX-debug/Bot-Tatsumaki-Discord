# 🤖 Bot de Discord con IA usando Groq (Gratis)
![Node.js](https://img.shields.io/badge/-Node.js-339933?style=flat-square&logo=node.js&logoColor=ffffff)
![Discord](https://img.shields.io/badge/-Discord-5865F2?style=flat-square&logo=discord&logoColor=ffffff)
![Groq](https://img.shields.io/badge/-Groq-F55036?style=flat-square&logo=groq&logoColor=ffffff)

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
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const Groq = require('groq-sdk');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const conversaciones = new Map();

// Evento de bienvenida
client.on('guildMemberAdd', async (member) => {
  const canal = member.guild.channels.cache.get('ID_DEL_CANAL_BIENVENIDA');
  if (!canal) return;

  try {
    const respuesta = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'Eres un pata peruano del servidor, hablas con jerga criolla y casual. Genera un mensaje de bienvenida corto, divertido y con jerga de barrio para un nuevo miembro.'
        },
        {
          role: 'user',
          content: `Dale bienvenida a ${member.user.username} al servidor`
        }
      ],
      max_tokens: 200,
    });

    const textoRespuesta = respuesta.choices[0].message.content;
    const avatarURL = member.user.displayAvatarURL({ size: 256, extension: 'png' });

    const embed = new EmbedBuilder()
      .setTitle('👋 BIENVENIDO AL COAR LIMA PROVINCIAS')
      .setDescription(textoRespuesta)
      .setThumbnail(avatarURL)
      .setColor(0x00bfff)
      .setFooter({ text: `Ya somos ${member.guild.memberCount} patas en el server` })
      .setTimestamp();

    canal.send({ embeds: [embed] });
  } catch (error) {
    console.error(error);
  }
});

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

    // Obtener solo emojis estáticos del servidor
    const emojisServidor = message.guild.emojis.cache
      .filter(e => !e.animated)
      .map(e => `<:${e.name}:${e.id}>`);
    const emojisTexto = emojisServidor.length > 0
      ? `Tienes acceso a estos emojis del servidor, úsalos de forma natural y random en tus respuestas: ${emojisServidor.join(', ')}`
      : '';

    const respuesta = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `Eres un pata peruano del servidor, hablas con jerga criolla y casual, haces bromas y te llevas con todos como amigos de barrio. ${emojisTexto}`
        },
        ...historial
      ],
      max_tokens: 1024,
    });

    const textoRespuesta = respuesta.choices[0].message.content;
    historial.push({ role: 'assistant', content: textoRespuesta });

    // Enviar sticker random con 10% de probabilidad
    const stickers = message.guild.stickers.cache;
    const debeEnviarSticker = Math.random() < 0.1;
    if (stickers.size > 0 && debeEnviarSticker) {
      const stickerRandom = stickers.random();
      await message.channel.send({ stickers: [stickerRandom] });
    }

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

## ✨ Funcionalidades [Discord](https://img.shields.io/badge/-Discord-5865F2?style=flat-square&logo=discord&logoColor=ffffff)

### Respuestas con IA
El bot responde mensajes de forma conversacional usando el modelo **LLaMA 3.1** a través de la API de Groq, manteniendo un historial de conversación por usuario de hasta 20 mensajes para recordar el contexto.

### Emojis del servidor
El bot detecta automáticamente los emojis estáticos del servidor y los utiliza de forma natural en sus respuestas. Los emojis animados se excluyen dado que su uso requiere Discord Nitro(IMPORTANTE).

### Stickers aleatorios
El bot tiene un 10% de probabilidad de enviar un sticker aleatorio del servidor tras cada respuesta. Este porcentaje puede ajustarse modificando el valor `0.1` en el código :) .

### Bienvenida automática
Cuando un nuevo miembro se une al servidor, el bot envía un mensaje de bienvenida generado por IA en el canal configurado. Dicho mensaje incluye:
- Título con el nombre del servidor
- Mensaje de bienvenida personalizado generado por IA
- Avatar del nuevo miembro
- Contador total de miembros del servidor

---

## ⚙️ Puntos clave a tener en cuenta

- **El bot responde cuando lo mencionas** con `@NombreDelBot`. Puede configurarse para que responda en un canal específico sin necesidad de mención.
- **Memoria por usuario:** cada usuario tiene su propio historial de conversación, permitiendo que el bot recuerde el contexto.
- **Puedes personalizar el `system`** para darle una personalidad específica al bot (formal, humorístico, experto en un tema, etc.).
- En el portal de Discord activa los permisos **"Message Content Intent"** y **"Server Members Intent"** en la sección **Bot → Privileged Gateway Intents**, de lo contrario el bot no podrá leer mensajes ni detectar nuevos miembros.
- Reemplaza `ID_DEL_CANAL_BIENVENIDA` con el ID real de tu canal. Para obtenerlo activa el **Modo Desarrollador** en Discord (Ajustes → Avanzado) y haz clic derecho sobre el canal → **Copiar ID**.
- En la sección de `👋 BIENVENIDO AL COAR LIMA PROVINCIAS` eres libre de ubicar el mensaje de bienvenida que desees.
- Si deseas una una asesoría personalizada del uso de esta herramienta puedes comunicarte con mi persona por el medio:

<div align="left">
  <img width="40px" src="https://i.pinimg.com/originals/1d/46/dd/1d46dda5b99cf1a91a1e2377fb948b36.gif" />
</div>

- Si estás viendo esto en su momento, feliz dia de la madre. Que la pases padre con tus familiares 🥳🥳

![Demo del bot](https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExemIxYXk3NWdqZGJuaGVxMzkweXM2ZHRid291ZGxzM2J5ejI1MjlzZCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/OuQmhmAAdJFLi/giphy.gif)

---
[website]: https://kernelx-debug.github.io/

## ☁️ Hosting gratuito 24/7

Para mantener el bot activo sin necesidad de tener tu PC encendida puedes usar [Railway](https://railway.app). Simplemente conecta tu repositorio de GitHub y agrega las variables de entorno `DISCORD_TOKEN` y `GROQ_API_KEY` en la sección **Variables**.
