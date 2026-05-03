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