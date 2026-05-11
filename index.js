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

// Enviar sticker random cada 5 mensajes
const stickers = message.guild.stickers.cache;
const debeEnviarSticker = Math.random() < 0.1; // 10% de probabilidad

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
