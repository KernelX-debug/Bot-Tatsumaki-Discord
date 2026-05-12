require('dotenv').config();

const { PassThrough } = require('node:stream');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const Groq = require('groq-sdk');
const WavDecoder = require('wav-decoder');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WELCOME_CHANNEL_ID = '1328382983547387999';
const BOT_PREFIX = '!';
const CHAT_MODEL = 'llama-3.1-8b-instant';
const TTS_MODEL = 'canopylabs/orpheus-v1-english';
const TTS_VOICE = 'diana';
const MAX_TTS_CHARS = 200;

if (!DISCORD_TOKEN) {
  throw new Error('Falta DISCORD_TOKEN en el archivo .env');
}

if (!GROQ_API_KEY) {
  throw new Error('Falta GROQ_API_KEY en el archivo .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const groq = new Groq({ apiKey: GROQ_API_KEY });
const conversaciones = new Map();
const voiceSessions = new Map();

function getConversationHistory(userId) {
  if (!conversaciones.has(userId)) {
    conversaciones.set(userId, []);
  }

  return conversaciones.get(userId);
}

function sanitizeMention(content) {
  return content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
}

function splitForTts(text, maxLength = MAX_TTS_CHARS) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [normalized];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      const words = sentence.split(' ');
      let longChunk = '';

      for (const word of words) {
        const candidate = longChunk ? `${longChunk} ${word}` : word;
        if (candidate.length <= maxLength) {
          longChunk = candidate;
          continue;
        }

        if (longChunk) {
          chunks.push(longChunk.trim());
        }

        if (word.length <= maxLength) {
          longChunk = word;
        } else {
          const parts = word.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
          chunks.push(...parts);
          longChunk = '';
        }
      }

      if (longChunk) {
        chunks.push(longChunk.trim());
      }

      continue;
    }

    const candidate = current ? `${current} ${sentence}`.trim() : sentence.trim();
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
      }
      current = sentence.trim();
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

function buildSystemPrompt(guild) {
  const emojisServidor = guild.emojis.cache
    .map((emoji) => (emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`));

  const emojisTexto = emojisServidor.length > 0
    ? `Tienes acceso a estos emojis del servidor, usalos de forma natural y random en tus respuestas: ${emojisServidor.join(', ')}`
    : '';

  return `Eres un pata peruano del servidor, hablas con jerga criolla y casual, haces bromas y te llevas con todos como amigos de barrio. ${emojisTexto}`.trim();
}

async function createGroqReply(message, userText) {
  const historial = getConversationHistory(message.author.id);
  historial.push({ role: 'user', content: userText });

  if (historial.length > 20) {
    historial.splice(0, historial.length - 20);
  }

  const respuesta = await groq.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(message.guild),
      },
      ...historial,
    ],
    max_tokens: 1024,
    temperature: 0.8,
  });

  const textoRespuesta = respuesta.choices?.[0]?.message?.content?.trim();

  if (!textoRespuesta) {
    throw new Error('Groq no devolvio texto en la respuesta.');
  }

  historial.push({ role: 'assistant', content: textoRespuesta });
  return textoRespuesta;
}

function getVoiceSession(guildId) {
  return voiceSessions.get(guildId) || null;
}

async function joinMemberVoiceChannel(member) {
  const voiceChannel = member.voice.channel;

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error('Debes estar en un canal de voz normal para que entre.');
  }

  if (!voiceChannel.joinable || !voiceChannel.speakable) {
    throw new Error('No tengo permisos para entrar o hablar en ese canal de voz.');
  }

  let session = getVoiceSession(member.guild.id);

  if (!session) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    connection.subscribe(player);
    player.on('error', (error) => {
      console.error('Error del reproductor de voz:', error);
    });

    session = {
      connection,
      player,
      queue: Promise.resolve(),
      channelId: voiceChannel.id,
    };

    connection.on('stateChange', (_, newState) => {
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        voiceSessions.delete(member.guild.id);
      }
    });

    voiceSessions.set(member.guild.id, session);
  } else if (session.channelId !== voiceChannel.id) {
    session.connection.rejoin({
      channelId: voiceChannel.id,
      selfDeaf: false,
      selfMute: false,
    });
    session.channelId = voiceChannel.id;
  }

  await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
  return session;
}

function leaveGuildVoice(guildId) {
  const session = getVoiceSession(guildId);
  if (!session) {
    return false;
  }

  session.player.stop(true);
  session.connection.destroy();
  voiceSessions.delete(guildId);
  return true;
}

async function synthesizeSpeechToBuffer(text) {
  try {
    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: `[casual] ${text}`,
      response_format: 'wav',
      sample_rate: 48000,
    });

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.includes('model_terms_required')) {
      throw new Error(`Groq bloqueo la voz porque todavia no aceptaste los terminos del modelo ${TTS_MODEL}. Entra a https://console.groq.com/playground?model=${encodeURIComponent(TTS_MODEL)} y aceptalos.`);
    }

    throw error;
  }
}

async function createPcmResourceFromWavBuffer(wavBuffer) {
  const decoded = await WavDecoder.decode(wavBuffer);

  if (decoded.sampleRate !== 48000) {
    throw new Error(`La voz de Groq devolvio ${decoded.sampleRate}Hz y Discord necesita 48000Hz.`);
  }

  const left = decoded.channelData[0];
  const right = decoded.channelData[1] || decoded.channelData[0];
  const pcmBuffer = Buffer.alloc(left.length * 4);

  for (let i = 0; i < left.length; i += 1) {
    const leftSample = Math.max(-1, Math.min(1, left[i]));
    const rightSample = Math.max(-1, Math.min(1, right[i]));
    const leftInt = leftSample < 0 ? leftSample * 0x8000 : leftSample * 0x7fff;
    const rightInt = rightSample < 0 ? rightSample * 0x8000 : rightSample * 0x7fff;

    pcmBuffer.writeInt16LE(Math.round(leftInt), i * 4);
    pcmBuffer.writeInt16LE(Math.round(rightInt), (i * 4) + 2);
  }

  const stream = new PassThrough();
  stream.end(pcmBuffer);

  return createAudioResource(stream, {
    inputType: StreamType.Raw,
  });
}

async function playSpeechChunk(session, textChunk) {
  const wavBuffer = await synthesizeSpeechToBuffer(textChunk);
  const resource = await createPcmResourceFromWavBuffer(wavBuffer);
  session.player.play(resource);

  try {
    await entersState(session.player, AudioPlayerStatus.Playing, 20_000);
  } catch (error) {
    throw new Error(`No se pudo empezar a reproducir el audio. Estado actual del player: ${session.player.state.status}`);
  }

  await entersState(session.player, AudioPlayerStatus.Idle, 60_000);
}

async function speakInVoice(session, text) {
  const chunks = splitForTts(text);

  if (chunks.length === 0) {
    return;
  }

  session.queue = session.queue.then(async () => {
    for (const chunk of chunks) {
      await playSpeechChunk(session, chunk);
    }
  }).catch((error) => {
    console.error('Error en la cola de voz:', error);
  });

  await session.queue;
}

async function replyLongMessage(message, text) {
  if (text.length <= 2000) {
    await message.reply(text);
    return;
  }

  const partes = text.match(/[\s\S]{1,2000}/g) || [];
  for (const parte of partes) {
    await message.reply(parte);
  }
}

client.on('guildMemberAdd', async (member) => {
  const canal = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!canal || !canal.isTextBased()) {
    return;
  }

  try {
    const respuesta = await groq.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Eres un pata peruano del servidor, hablas con jerga criolla y casual. Genera un mensaje de bienvenida corto, divertido y con jerga de barrio para un nuevo miembro.',
        },
        {
          role: 'user',
          content: `Dale bienvenida a ${member.user.username} al servidor`,
        },
      ],
      max_tokens: 200,
      temperature: 0.9,
    });

    const textoRespuesta = respuesta.choices?.[0]?.message?.content?.trim();
    if (!textoRespuesta) {
      return;
    }

    const avatarURL = member.user.displayAvatarURL({ size: 256, extension: 'png' });

    const embed = new EmbedBuilder()
      .setTitle('👋 BIENVENIDO AL COAR LIMA PROVINCIAS')
      .setDescription(textoRespuesta)
      .setThumbnail(avatarURL)
      .setColor(0x00bfff)
      .setFooter({ text: `Ya somos ${member.guild.memberCount} patas en el server` })
      .setTimestamp();

    await canal.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error en bienvenida:', error);
  }
});

client.once('clientReady', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  const content = message.content.trim();
  const lower = content.toLowerCase();

  try {
    if (lower === `${BOT_PREFIX}join`) {
      const session = await joinMemberVoiceChannel(message.member);
      const channelName = message.guild.channels.cache.get(session.channelId)?.name || 'tu canal de voz';
      await message.reply(`Listo, ya entre a **${channelName}**.`);
      return;
    }

    if (lower === `${BOT_PREFIX}leave`) {
      const disconnected = leaveGuildVoice(message.guild.id);
      await message.reply(disconnected ? 'Sali del canal de voz.' : 'No estaba conectado a ningun canal de voz.');
      return;
    }

    if (lower.startsWith(`${BOT_PREFIX}say `)) {
      const textToSpeak = content.slice(`${BOT_PREFIX}say `.length).trim();
      if (!textToSpeak) {
        await message.reply(`Usa \`${BOT_PREFIX}say tu texto\``);
        return;
      }

      const session = await joinMemberVoiceChannel(message.member);
      await message.reply('Ya fue, lo digo en voz.');
      await speakInVoice(session, textToSpeak);
      return;
    }

    if (!message.mentions.has(client.user)) {
      return;
    }

    const texto = sanitizeMention(content);

    if (!texto) {
      await message.reply('¡Hola! ¿En qué te puedo ayudar? 😊');
      return;
    }

    await message.channel.sendTyping();
    const textoRespuesta = await createGroqReply(message, texto);

    const stickers = message.guild.stickers.cache;
    const debeEnviarSticker = Math.random() < 0.1;
    if (stickers.size > 0 && debeEnviarSticker) {
      const stickerRandom = stickers.random();
      await message.channel.send({ stickers: [stickerRandom] });
    }

    await replyLongMessage(message, textoRespuesta);

    if (message.member.voice.channel) {
      const session = await joinMemberVoiceChannel(message.member);
      await speakInVoice(session, textoRespuesta);
    }
  } catch (error) {
    console.error('Error general:', error);
    await message.reply(`Hubo un error: ${error.message}`);
  }
});

client.login(DISCORD_TOKEN);
